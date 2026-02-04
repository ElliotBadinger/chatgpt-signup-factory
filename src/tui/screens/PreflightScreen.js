import React from 'react';
import { Box, Text, useInput } from 'ink';
import { Header } from '../components/Header.js';

const h = React.createElement;

export function PreflightScreen({ preflight, onBack, onNext }) {
  const isActive = Boolean(process.stdin && process.stdin.isTTY);

  useInput(
    (input, key) => {
      if (input.toLowerCase() === 'b') onBack();
      if (key.return && preflight.ok) onNext();
    },
    { isActive }
  );

  const checks = preflight.checks || [];

  return h(
    Box,
    { flexDirection: 'column' },
    h(Header, { title: 'Preflight Checklist' }),
    h(
      Box,
      { flexDirection: 'column', marginBottom: 1 },
      ...checks.map((c, i) => h(
        Text,
        { key: i, color: c.ok ? 'green' : 'red' },
        `${c.ok ? '✓' : '✗'} ${c.name}${c.message ? `: ${c.message}` : ''}`
      ))
    ),
    h(Text, null, ' '),
    h(Box, { flexDirection: 'row' },
      h(Text, { dimColor: true }, '[b] Back  '),
      h(Text, { dimColor: true }, preflight.ok ? 'Enter → Confirm' : 'Fix issues then restart')
    )
  );
}
