import React from 'react';
import { Box, Text } from 'ink';
import Spinner from 'ink-spinner';
import { formatAgentState } from '../stateLabels.js';

const h = React.createElement;

function colorForStatus(status) {
  if (status === 'success') return 'green';
  if (status === 'failure') return 'red';
  if (status === 'running') return 'cyan';
  return 'gray';
}

export function StatusBar({ runMeta, timeline }) {
  const status = runMeta?.status || 'idle';
  const color = colorForStatus(status);

  const lastStateEv = [...(timeline || [])].reverse().find((e) => e?.type === 'state:change');
  const state = formatAgentState(lastStateEv?.state);

  return h(
    Box,
    { borderStyle: 'round', borderColor: color, paddingX: 1, justifyContent: 'space-between' },
    h(
      Box,
      { flexDirection: 'row' },
      status === 'running' ? h(Text, { color }, h(Spinner, { type: 'dots' }), ' ') : null,
      h(Text, { color, bold: true }, status.toUpperCase())
    ),
    h(
      Box,
      { flexDirection: 'row' },
      h(Text, { dimColor: true }, 'Phase: '),
      h(Text, null, state.phase),
      h(Text, { dimColor: true }, '  State: '),
      h(Text, null, state.label)
    )
  );
}
