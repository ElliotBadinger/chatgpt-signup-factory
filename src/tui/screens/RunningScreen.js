import React, { useMemo, useState } from 'react';
import { Box, Text, useInput } from 'ink';

import { Header } from '../components/Header.js';
import { ArtifactList } from '../components/ArtifactList.js';
import { StatusBar } from '../components/StatusBar.js';
import { LogViewer } from '../components/LogViewer.js';
import { Events } from '../../orchestrator/events.js';
import { formatAgentState } from '../stateLabels.js';

const h = React.createElement;

function formatEvent(ev) {
  if (!ev) return '';
  if (ev.type === Events.STATE_CHANGE) {
    const s = formatAgentState(ev.state);
    return `State → ${s.label}`;
  }
  if (ev.type === Events.CHECKPOINT_BEFORE_SUBSCRIBE) {
    return 'Checkpoint → approval required';
  }
  return ev.type;
}

export function RunningScreen({
  timeline,
  runMeta,
  checkpointPending,
  onCheckpointDecision,
  artifacts = [],
  isActive: isActiveProp,
  failureSnapshotExcerpt,
}) {
  const isActive = isActiveProp ?? Boolean(process.stdin && process.stdin.isTTY);
  const [logLevel, setLogLevel] = useState('info'); // info, warn, error

  useInput(
    (input) => {
      if (checkpointPending) {
        const c = input.toLowerCase();
        if (c === 'y') onCheckpointDecision(true);
        if (c === 'n') onCheckpointDecision(false);
        return;
      }

      if (input.toLowerCase() === '1') setLogLevel('info');
      if (input.toLowerCase() === '2') setLogLevel('warn');
      if (input.toLowerCase() === '3') setLogLevel('error');
    },
    { isActive }
  );

  const timelineEvents = useMemo(() => {
    return (timeline || []).filter((ev) => ev.type !== Events.LOG_LINE).slice(-8);
  }, [timeline]);

  const logEvents = useMemo(() => {
    return (timeline || [])
      .filter((ev) => {
        if (ev.type !== Events.LOG_LINE) return false;
        if (logLevel === 'info') return true;
        if (logLevel === 'warn') return ev.level === 'warn' || ev.level === 'error';
        if (logLevel === 'error') return ev.level === 'error';
        return true;
      })
      .slice(-10);
  }, [timeline, logLevel]);

  const lastAgentState = useMemo(() => {
    const lastStateEv = [...(timeline || [])].reverse().find((e) => e.type === Events.STATE_CHANGE);
    return formatAgentState(lastStateEv?.state);
  }, [timeline]);

  return h(
    Box,
    { flexDirection: 'column' },
    h(Header, { title: 'Running' }),
    h(StatusBar, { runMeta, timeline }),
    h(
      Box,
      { justifyContent: 'space-between', marginTop: 1, marginBottom: 1 },
      h(Text, { dimColor: true }, `Run ID: ${runMeta.runId || '...'}`),
      h(Text, { dimColor: true }, `Dir: ${runMeta.runDir || '...'}`)
    ),

    checkpointPending &&
      h(
        Box,
        { flexDirection: 'column', borderStyle: 'double', borderColor: 'yellow', paddingX: 1, marginBottom: 1 },
        h(Text, { color: 'yellow', bold: true }, 'CHECKPOINT REQUIRED'),
        h(Text, null, 'The agent requests approval before clicking Subscribe.'),
        h(Text, null, `Plan: ${checkpointPending.message || 'Proceed to subscribe click'}`),
        checkpointPending.runDir
          ? h(Text, { dimColor: true }, `Run Dir: ${checkpointPending.runDir}`)
          : null,
        h(Text, { dimColor: true }, `Latest Snapshot: ${artifacts.filter((a) => a.endsWith('.txt')).pop() || 'none'}`),
        h(Text, { dimColor: true }, `Latest Screenshot: ${artifacts.filter((a) => a.endsWith('.png')).pop() || 'none'}`),
        h(Text, { bold: true }, 'Press [y] approve, [n] reject')
      ),

    h(
      Box,
      { flexGrow: 1, flexDirection: 'row' },
      h(
        Box,
        { flexDirection: 'column', width: '60%', marginRight: 2 },
        h(Text, { bold: true }, 'Activity'),
        h(
          Box,
          { flexDirection: 'column', marginTop: 1, marginBottom: 1 },
          timelineEvents.length === 0
            ? h(Text, { dimColor: true }, '(no events yet)')
            : timelineEvents.map((ev, idx) =>
                h(
                  Text,
                  { key: idx, wrap: 'truncate-end' },
                  h(Text, { dimColor: true }, `${new Date(ev.ts || 0).toLocaleTimeString()} `),
                  formatEvent(ev)
                )
              )
        ),
        h(LogViewer, { events: logEvents, title: `Logs (${logLevel})`, maxLines: 10 })
      ),
      h(
        Box,
        { flexDirection: 'column', width: '40%' },
        h(Text, { bold: true }, 'Artifacts'),
        h(Box, { marginTop: 1 }, h(ArtifactList, { artifacts }))
      )
    ),

    runMeta.status === 'failure' &&
      h(
        Box,
        { flexDirection: 'column', borderStyle: 'single', borderColor: 'red', paddingX: 1, marginTop: 1 },
        h(Text, { color: 'red', bold: true }, 'FAILURE SUMMARY'),
        h(Text, null, `Phase: ${lastAgentState.phase}`),
        h(Text, null, `State: ${lastAgentState.label}`),
        h(Text, null, `Error: ${runMeta.error || 'Unknown error'}`),
        failureSnapshotExcerpt
          ? h(
              Box,
              { marginTop: 1, paddingX: 1, borderStyle: 'round', borderColor: 'gray' },
              h(Text, { dimColor: true }, failureSnapshotExcerpt)
            )
          : null
      ),

    h(
      Box,
      { marginTop: 1, flexDirection: 'row' },
      h(Text, { dimColor: true }, 'Log filter: '),
      h(Text, { color: logLevel === 'info' ? 'cyan' : undefined }, '[1] Info '),
      h(Text, { color: logLevel === 'warn' ? 'cyan' : undefined }, '[2] Warn '),
      h(Text, { color: logLevel === 'error' ? 'cyan' : undefined }, '[3] Error '),
      h(Box, { flexGrow: 1 }),
      h(Text, { dimColor: true }, 'Ctrl+C abort')
    )
  );
}
