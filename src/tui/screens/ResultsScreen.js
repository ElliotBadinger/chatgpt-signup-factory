import React from 'react';
import { Box, Text, useInput } from 'ink';
import { Header } from '../components/Header.js';

const h = React.createElement;

export function ResultsScreen({ runMeta }) {
  const color = runMeta.status === 'success' ? 'green' : runMeta.status === 'failure' ? 'red' : 'yellow';

  return h(
    Box,
    { flexDirection: 'column' },
    h(Header, { title: 'Results' }),
    h(Box, { borderStyle: 'round', borderColor: color, paddingX: 2, marginBottom: 1 },
      h(Text, { color, bold: true }, `Status: ${runMeta.status.toUpperCase()}`)
    ),
    runMeta.error ? h(
      Box, 
      { flexDirection: 'column', marginBottom: 1 },
      h(Text, { color: 'red', bold: true }, 'Error:'),
      h(Text, null, runMeta.error)
    ) : null,
    runMeta.vaultWarning ? h(
      Box,
      { flexDirection: 'column', marginBottom: 1 },
      h(Text, { color: 'yellow', bold: true }, 'Vault Warning:'),
      h(Text, null, runMeta.vaultWarning)
    ) : null,
    h(Text, null, `Run ID:   ${runMeta.runId || 'N/A'}`),
    h(Text, null, `Location: ${runMeta.runDir || 'N/A'}`),
    h(Text, null, `Bundle:   ${runMeta.runDir ? `${runMeta.runDir}/run.bundle.json` : 'N/A'}`),
    h(Text, null, ' '),
    h(Text, { dimColor: true }, 'Press [q] to exit')
  );
}
