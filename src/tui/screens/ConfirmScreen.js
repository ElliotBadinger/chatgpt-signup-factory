import React, { useMemo } from 'react';
import { Box, Text, useInput } from 'ink';

import { Header } from '../components/Header.js';
import { KeyValueTable } from '../components/KeyValueTable.js';

const h = React.createElement;

export function ConfirmScreen({ configRedacted, onBack, onStart, isActive: isActiveProp }) {
  const isActive = isActiveProp ?? Boolean(process.stdin && process.stdin.isTTY);

  useInput(
    (input, key) => {
      if (input.toLowerCase() === 'b') onBack?.();
      if (key.return) onStart?.();
    },
    { isActive }
  );

  const rows = useMemo(() => {
    const c = configRedacted || {};
    return [
      ['Headless', c.run?.headless],
      ['Stealth', c.run?.stealth],
      ['Seats', c.plan?.seats],
      ['Cadence', c.plan?.cadence],
      ['Confirm before subscribe', c.safety?.requireConfirmBeforeSubscribe],
      ['Artifacts dir', c.artifacts?.outputDir],
      ['Email', c.identity?.email || '(auto)'],
      ['Password', c.identity?.password || '(generated)'],
    ];
  }, [configRedacted]);

  return h(
    Box,
    { flexDirection: 'column' },
    h(Header, { title: 'Confirm & Start' }),
    h(
      Box,
      { borderStyle: 'round', borderColor: 'gray', paddingX: 1, marginBottom: 1 },
      h(Text, { bold: true }, 'What will happen'),
      h(Text, null, '- Provision an email inbox'),
      h(Text, null, '- Complete signup/login + onboarding'),
      h(Text, null, '- Navigate to checkout'),
      h(Text, null, '- (Optional) wait for approval before clicking Subscribe')
    ),
    h(
      Box,
      { borderStyle: 'round', borderColor: 'gray', paddingX: 1, marginBottom: 1 },
      h(Text, { bold: true }, 'Config (redacted)'),
      h(Box, { marginTop: 1, flexDirection: 'column' }, h(KeyValueTable, { rows }))
    ),
    h(
      Box,
      { flexDirection: 'row' },
      h(Text, { dimColor: true }, '[b] Back  '),
      h(Text, { dimColor: true }, 'Enter → Start run')
    )
  );
}
