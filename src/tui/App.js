import fs from 'fs';
import React, { useMemo, useReducer, useRef, useState } from 'react';
import { Box, useApp, useInput } from 'ink';

import { validateConfig, loadConfig, saveConfig } from '../config/manager.js';
import { redactConfig } from '../config/redaction.js';
import { mapLoadedConfigToState, mapStateToRunConfig } from './configHelpers.js';
import { ArtifactManager } from '../artifacts/ArtifactManager.js';
import { RunOrchestrator } from '../orchestrator/RunOrchestrator.js';
import { Events } from '../orchestrator/events.js';
import { AgentMailProvider } from '../AgentMailProvider.js';
import { EmailProvisioner } from '../EmailProvisioner.js';
import { runPreflight } from './preflight.js';
import { RunLogger } from './runLogger.js';

import { createInitialState, reducer, Screens } from './stateMachine.js';
import { WizardScreen } from './screens/WizardScreen.js';
import { PreflightScreen } from './screens/PreflightScreen.js';
import { ConfirmScreen } from './screens/ConfirmScreen.js';
import { RunningScreen } from './screens/RunningScreen.js';
import { ResultsScreen } from './screens/ResultsScreen.js';
import { NotificationBar } from './components/NotificationBar.js';

const h = React.createElement;

const redactSnapshotText = (text) => {
  if (!text || typeof text !== 'string') return '';
  const masked = text
    .replace(/(password|cvc|cardNumber)\s*[:=]\s*\S+/gi, '$1: [REDACTED]')
    .replace(/\b([A-Z0-9._%+-]{1,})@([A-Z0-9.-]+\.[A-Z]{2,})\b/gi, '***@$2')
    .replace(/\b\d{12,19}\b/g, (match) => `**** **** **** ${match.slice(-4)}`);
  return masked;
};

export default function App({
  isActive: isActiveProp,
  configPath = 'config.yaml',
  initialConfig = null,
  preflightProvider = null,
  orchestratorFactory = null,
  provisionerFactory = null,
} = {}) {
  const { exit } = useApp();

  const [ui, dispatch] = useReducer(reducer, undefined, createInitialState);
  const [config, setConfig] = useState(() => {
    if (initialConfig) return validateConfig(initialConfig);
    return validateConfig({});
  });
  const [timeline, setTimeline] = useState([]);
  const [artifacts, setArtifacts] = useState([]);
  const [failureSnapshotExcerpt, setFailureSnapshotExcerpt] = useState(null);
  const [runMeta, setRunMeta] = useState({ status: 'idle', runId: null, runDir: null, error: null });
  const [notification, setNotification] = useState(null);

  const notify = (level, message, detail = null) => {
    setNotification({ level, message, detail, ts: Date.now() });
  };

  // Checkpoint (before subscribe) approval bridge
  const checkpointResolveRef = useRef(null);
  const [checkpointPending, setCheckpointPending] = useState(false);

  const isActive = isActiveProp ?? Boolean(process.stdin && process.stdin.isTTY);

  useInput(
    (input, key) => {
      if (key.ctrl && input === 'c') {
        exit();
      }
      if (ui.screen === Screens.RESULTS && input.toLowerCase() === 'q') {
        exit();
      }
    },
    { isActive }
  );

  const preflight = useMemo(() => {
    const provider =
      preflightProvider ||
      (({ env, artifactsDir }) => runPreflight({ env, artifactsDir }));

    // Allow simple no-arg providers in tests.
    return provider.length === 0
      ? provider()
      : provider({ env: process.env, artifactsDir: config.artifacts?.outputDir });
  }, [preflightProvider, config.artifacts?.outputDir]);

  const handleLoadYaml = () => {
    try {
      const loaded = loadConfig(configPath);
      setConfig(mapLoadedConfigToState(loaded));
      notify('success', `Loaded ${configPath}`);
    } catch (e) {
      notify('error', `Failed to load ${configPath}`, String(e?.message || e));
    }
  };

  const handleSaveYaml = () => {
    try {
      saveConfig(configPath, config);
      notify('success', `Saved ${configPath}`);
    } catch (e) {
      notify('error', `Failed to save ${configPath}`, String(e?.message || e));
    }
  };

  const startRun = async () => {
    dispatch({ type: 'RUN_START' });
    setRunMeta({ status: 'running', runId: null, runDir: null, error: null });
    setTimeline([]);
    setArtifacts([]);
    setFailureSnapshotExcerpt(null);
    notify('info', 'Run started');

    const artifactManager = new ArtifactManager({ baseDir: config.artifacts.outputDir, config });
    const logger = new RunLogger({ artifactManager });
    setRunMeta((prev) => ({ ...prev, runId: artifactManager.getRunId(), runDir: artifactManager.getRunDir() }));
    artifactManager.updateManifest({ status: 'running' });

    const checkpointProvider = {
      approve: async (checkpoint) => {
        setCheckpointPending({
          ...checkpoint,
          runDir: artifactManager.getRunDir()
        });
        return await new Promise((resolve) => {
          checkpointResolveRef.current = (approved) => {
            setCheckpointPending(false);
            resolve(approved);
          };
        });
      },
    };

    const orchestrator = (orchestratorFactory || ((deps) => new RunOrchestrator({
      agentMailApiKey: process.env.AGENTMAIL_API_KEY,
      ...deps,
    })))({
      checkpointProvider,
      artifactManager,
      logger,
    });

    const pushEvent = (ev) => {
      setTimeline((tl) => [...tl, { ts: Date.now(), ...ev }].slice(-200));
      if (ev.type === Events.ARTIFACT_WRITTEN) {
        const runDir = artifactManager.getRunDir();
        const relPath = ev.path.startsWith(runDir) 
          ? ev.path.slice(runDir.length).replace(/^[/\\]+/, '') 
          : ev.path;
        setArtifacts(a => [...a, relPath]);

        if (ev.path.endsWith('.txt')) {
          try {
            const content = fs.readFileSync(ev.path, 'utf8');
            const redacted = redactSnapshotText(content);
            const excerpt = redacted.slice(0, 200).replace(/[\r\n]+/g, ' ').trim();
            setFailureSnapshotExcerpt(excerpt);
          } catch (e) {
            // ignore read errors
          }
        }
      }
    };

    orchestrator.on(Events.RUN_START, pushEvent);
    orchestrator.on(Events.STATE_CHANGE, pushEvent);
    orchestrator.on(Events.ARTIFACT_WRITTEN, pushEvent);
    orchestrator.on(Events.CHECKPOINT_BEFORE_SUBSCRIBE, pushEvent);
    orchestrator.on(Events.LOG_LINE, pushEvent);
    orchestrator.on(Events.RUN_SUCCESS, pushEvent);
    orchestrator.on(Events.RUN_FAILURE, pushEvent);

    let provisioner = null;

    try {
      if (provisionerFactory) {
        provisioner = provisionerFactory({ env: process.env });
      } else {
        const agentMailProvider = new AgentMailProvider(process.env.AGENTMAIL_API_KEY);
        provisioner = new EmailProvisioner({ agentMailProvider, env: process.env });
      }
      const provisioned = await provisioner.provision();

      const runConfig = mapStateToRunConfig({
        state: config,
        provisioned,
        artifactManager
      });

      await orchestrator.run({ config: runConfig });

      artifactManager.updateManifest({ status: 'success' });
      setRunMeta((prev) => ({ ...prev, status: 'success' }));
      notify('success', 'Run completed successfully');
      dispatch({ type: 'RUN_SUCCESS' });
    } catch (e) {
      artifactManager.updateManifest({ status: 'failure', failure_summary: String(e?.message || e) });
      setRunMeta((prev) => ({ ...prev, status: 'failure', error: String(e?.message || e) }));
      notify('error', 'Run failed', String(e?.message || e));
      dispatch({ type: 'RUN_FAILURE', error: String(e?.message || e) });
    } finally {
      if (provisioner) {
        try {
          await provisioner.cleanup();
        } catch {}
      }
    }
  };

  const approveCheckpoint = (approved) => {
    if (checkpointResolveRef.current) {
      checkpointResolveRef.current(approved);
      checkpointResolveRef.current = null;
    }
  };

  if (ui.screen === Screens.WIZARD) {
    return h(
      Box,
      { flexDirection: 'column' },
      h(NotificationBar, { notification }),
      h(WizardScreen, {
        config,
        setConfig,
        onNext: () => dispatch({ type: 'NAV_NEXT' }),
        onLoadYaml: handleLoadYaml,
        onSaveYaml: handleSaveYaml,
        isActive,
      })
    );
  }

  if (ui.screen === Screens.PREFLIGHT) {
    return h(
      Box,
      { flexDirection: 'column' },
      h(NotificationBar, { notification }),
      h(PreflightScreen, {
        preflight,
        onBack: () => dispatch({ type: 'NAV_BACK' }),
        onNext: () => dispatch({ type: 'NAV_NEXT' }),
        isActive,
      })
    );
  }

  if (ui.screen === Screens.CONFIRM) {
    return h(
      Box,
      { flexDirection: 'column' },
      h(NotificationBar, { notification }),
      h(ConfirmScreen, {
        configRedacted: redactConfig(config),
        onBack: () => dispatch({ type: 'NAV_BACK' }),
        onStart: startRun,
        isActive,
      })
    );
  }

  if (ui.screen === Screens.RUNNING) {
    return h(
      Box,
      { flexDirection: 'column' },
      h(NotificationBar, { notification }),
      h(RunningScreen, {
        timeline,
        runMeta,
        checkpointPending,
        onCheckpointDecision: approveCheckpoint,
        artifacts,
        failureSnapshotExcerpt,
        isActive,
      })
    );
  }

  return h(
    Box,
    { flexDirection: 'column' },
    h(NotificationBar, { notification }),
    h(ResultsScreen, { runMeta })
  );
}
