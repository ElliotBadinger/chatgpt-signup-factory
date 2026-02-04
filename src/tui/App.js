import fs from 'fs';
import React, { useMemo, useReducer, useRef, useState } from 'react';
import { useApp, useInput } from 'ink';

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

const h = React.createElement;

export default function App({ isActive: isActiveProp, configPath = 'config.yaml' } = {}) {
  const { exit } = useApp();

  const [ui, dispatch] = useReducer(reducer, undefined, createInitialState);
  const [config, setConfig] = useState(() => validateConfig({}));
  const [timeline, setTimeline] = useState([]);
  const [artifacts, setArtifacts] = useState([]);
  const [failureSnapshotExcerpt, setFailureSnapshotExcerpt] = useState(null);
  const [runMeta, setRunMeta] = useState({ status: 'idle', runId: null, runDir: null, error: null });

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
    return runPreflight({ env: process.env, artifactsDir: config.artifacts?.outputDir });
  }, [config.artifacts?.outputDir]);

  const handleLoadYaml = () => {
    try {
      const loaded = loadConfig(configPath);
      setConfig(mapLoadedConfigToState(loaded));
    } catch (e) {
      console.error('Load failed', e);
    }
  };

  const handleSaveYaml = () => {
    try {
      saveConfig('config.yaml', config);
    } catch (e) {
      // Potentially show error in UI
    }
  };

  const startRun = async () => {
    dispatch({ type: 'RUN_START' });
    setRunMeta({ status: 'running', runId: null, runDir: null, error: null });
    setTimeline([]);
    setArtifacts([]);
    setFailureSnapshotExcerpt(null);

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

    const orchestrator = new RunOrchestrator({
      agentMailApiKey: process.env.AGENTMAIL_API_KEY,
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
            const excerpt = content.slice(0, 200).replace(/[\r\n]+/g, ' ').trim();
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
      const agentMailProvider = new AgentMailProvider(process.env.AGENTMAIL_API_KEY);
      provisioner = new EmailProvisioner({ agentMailProvider, env: process.env });
      const provisioned = await provisioner.provision();

      const runConfig = mapStateToRunConfig({
        state: config,
        provisioned,
        artifactManager
      });

      await orchestrator.run({ config: runConfig });

      artifactManager.updateManifest({ status: 'success' });
      setRunMeta((prev) => ({ ...prev, status: 'success' }));
      dispatch({ type: 'RUN_SUCCESS' });
    } catch (e) {
      artifactManager.updateManifest({ status: 'failure', failure_summary: String(e?.message || e) });
      setRunMeta((prev) => ({ ...prev, status: 'failure', error: String(e?.message || e) }));
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
    return h(WizardScreen, {
      config,
      setConfig,
      onNext: () => dispatch({ type: 'NAV_NEXT' }),
      onLoadYaml: handleLoadYaml,
      onSaveYaml: handleSaveYaml,
      isActive,
    });
  }

  if (ui.screen === Screens.PREFLIGHT) {
    return h(PreflightScreen, {
      preflight,
      onBack: () => dispatch({ type: 'NAV_BACK' }),
      onNext: () => dispatch({ type: 'NAV_NEXT' }),
    });
  }

  if (ui.screen === Screens.CONFIRM) {
    return h(ConfirmScreen, {
      configRedacted: redactConfig(config),
      onBack: () => dispatch({ type: 'NAV_BACK' }),
      onStart: startRun,
    });
  }

  if (ui.screen === Screens.RUNNING) {
    return h(RunningScreen, {
      timeline,
      runMeta,
      checkpointPending,
      onCheckpointDecision: approveCheckpoint,
      artifacts,
      failureSnapshotExcerpt,
    });
  }

  return h(ResultsScreen, { runMeta });
}
