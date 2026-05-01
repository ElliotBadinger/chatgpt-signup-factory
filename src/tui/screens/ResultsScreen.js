import React, { useMemo } from 'react';
import { Box, Text } from 'ink';

import { Header } from '../components/Header.js';
import { KeyValueTable } from '../components/KeyValueTable.js';

const h = React.createElement;

export function ResultsScreen({ runMeta }) {
  const status = runMeta?.status || 'idle';
  const color = status === 'success' ? 'green' : status === 'failure' ? 'red' : 'yellow';

  const rows = useMemo(() => {
    return [
      ['Status', status.toUpperCase()],
      ['Run ID', runMeta?.runId || 'N/A'],
      ['Run dir', runMeta?.runDir || 'N/A'],
      ['Bundle', runMeta?.runDir ? `${runMeta.runDir}/run.bundle.json` : 'N/A'],
    ];
  }, [runMeta, status]);

  return h(
    Box,
    { flexDirection: 'column' },
    h(Header, { title: 'Results' }),
    h(
      Box,
      { borderStyle: 'round', borderColor: color, paddingX: 1, marginBottom: 1 },
      h(Text, { color, bold: true }, status.toUpperCase() === 'SUCCESS' ? 'SUCCESS' : status.toUpperCase() === 'FAILURE' ? 'FAILURE' : status.toUpperCase())
    ),
    runMeta?.error
      ? h(
          Box,
          { flexDirection: 'column', borderStyle: 'round', borderColor: 'red', paddingX: 1, marginBottom: 1 },
          h(Text, { color: 'red', bold: true }, 'Error'),
          h(Text, null, runMeta.error)
        )
      : null,
    runMeta?.vaultWarning
      ? h(
          Box,
          { flexDirection: 'column', borderStyle: 'round', borderColor: 'yellow', paddingX: 1, marginBottom: 1 },
          h(Text, { color: 'yellow', bold: true }, 'Vault Warning'),
          h(Text, null, runMeta.vaultWarning)
        )
      : null,
    h(Box, { borderStyle: 'round', borderColor: 'gray', paddingX: 1, marginBottom: 1 }, h(KeyValueTable, { rows })),
    h(Text, { dimColor: true }, 'Next steps:'),
    status === 'success'
      ? h(Text, { dimColor: true }, '- Use the provisioned account immediately (see run bundle for details)')
      : h(Text, { dimColor: true }, '- Inspect artifacts (latest snapshot + screenshot) and run.bundle.json'),
    h(Text, { dimColor: true }, 'Press [q] to exit')
  );
}
