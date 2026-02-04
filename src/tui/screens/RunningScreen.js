import React, { useMemo, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { Header } from '../components/Header.js';
import { ArtifactList } from '../components/ArtifactList.js';
import { Events } from '../../orchestrator/events.js';

const h = React.createElement;

export function RunningScreen({ timeline, runMeta, checkpointPending, onCheckpointDecision, artifacts = [], isActive: isActiveProp }) {
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

  const filteredTimeline = useMemo(() => {
    return (timeline || []).filter(ev => {
      if (ev.type !== Events.LOG_LINE) return true;
      if (logLevel === 'info') return true;
      if (logLevel === 'warn') return ev.level === 'warn' || ev.level === 'error';
      if (logLevel === 'error') return ev.level === 'error';
      return true;
    });
  }, [timeline, logLevel]);

  const lastEvents = useMemo(() => (filteredTimeline || []).slice(-10), [filteredTimeline]);

  const failureContext = useMemo(() => {
    if (runMeta.status !== 'failure') return null;
    const lastState = [...timeline].reverse().find(ev => ev.type === Events.STATE_CHANGE)?.state || 'unknown';
    const lastSnapshot = artifacts.filter(a => a.endsWith('.txt') || a.endsWith('.png')).slice(-2);
    return { lastState, lastSnapshot };
  }, [runMeta.status, timeline, artifacts]);

  return h(
    Box,
    { flexDirection: 'column' },
    h(Header, { title: 'Running' }),
    h(Box, { justifyContent: 'space-between', marginBottom: 1 },
      h(Text, { dimColor: true }, `ID: ${runMeta.runId || '...'}`),
      h(Text, { dimColor: true }, `Dir: ${runMeta.runDir || '...'}`)
    ),

    checkpointPending && h(
      Box,
      { flexDirection: 'column', borderStyle: 'double', borderColor: 'yellow', paddingX: 1, marginBottom: 1 },
      h(Text, { color: 'yellow', bold: true }, '⚠ CHECKPOINT REQUIRED'),
      h(Text, null, 'The agent is requesting permission to proceed.'),
      h(Text, null, `Plan: ${checkpointPending.message || 'what will happen'}`),
      h(Box, { flexDirection: 'column', marginTop: 1 },
        h(Text, { dimColor: true }, `Run Dir: ${checkpointPending.runDir}`),
        h(Text, { dimColor: true }, `Latest Screenshot: ${artifacts.filter(a => a.endsWith('.png')).pop() || 'none'}`)
      ),
      h(Text, { bold: true, marginTop: 1 }, 'Press [y] approve, [n] reject')
    ),

    h(Box, { flexGrow: 1, flexDirection: 'row' },
      h(Box, { flexDirection: 'column', width: '60%', marginRight: 2 },
        h(Text, { bold: true, underline: true }, 'Timeline'),
        h(Box, { flexDirection: 'column', marginY: 1 },
          lastEvents.length === 0
            ? h(Text, { dimColor: true }, '(no events)')
            : lastEvents.map((ev, idx) =>
                h(Text, { key: idx, wrap: 'truncate-end' }, 
                  h(Text, { color: 'gray' }, `${new Date(ev.ts || 0).toLocaleTimeString()} `),
                  ev.type === Events.LOG_LINE 
                    ? h(Text, { color: ev.level === 'error' ? 'red' : ev.level === 'warn' ? 'yellow' : undefined }, `[${ev.level || 'info'}] ${ev.message}`)
                    : `${ev.type}${ev.state ? ` [${ev.state}]` : ''}`
                )
              )
        )
      ),
      h(Box, { flexDirection: 'column', width: '40%' },
        h(Text, { bold: true, underline: true }, 'Artifacts'),
        h(Box, { marginY: 1 },
          h(ArtifactList, { artifacts })
        )
      )
    ),

    runMeta.status === 'failure' && h(
      Box,
      { flexDirection: 'column', borderStyle: 'single', borderColor: 'red', paddingX: 1, marginTop: 1 },
      h(Text, { color: 'red', bold: true }, 'FAILURE SUMMARY'),
      h(Text, null, `State: ${failureContext?.lastState}`),
      h(Text, null, `Error: ${runMeta.error || 'Unknown error'}`),
      failureContext?.lastSnapshot?.length > 0 && h(
        Box,
        { flexDirection: 'column', marginTop: 1 },
        h(Text, { dimColor: true }, 'Last Snapshots:'),
        ...failureContext.lastSnapshot.map(s => h(Text, { key: s, dimColor: true }, ` - ${s}`))
      )
    ),

    h(Box, { marginTop: 1, flexDirection: 'row' },
      h(Text, { dimColor: true }, 'Logs: '),
      h(Text, { color: logLevel === 'info' ? 'blue' : undefined }, '[1] Info '),
      h(Text, { color: logLevel === 'warn' ? 'blue' : undefined }, '[2] Warn '),
      h(Text, { color: logLevel === 'error' ? 'blue' : undefined }, '[3] Error '),
      h(Box, { flexGrow: 1 }),
      h(Text, { dimColor: true }, 'Ctrl+C to abort')
    )
  );
}
