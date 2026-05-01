import React, { useMemo } from 'react';
import { Box, Text, useInput } from 'ink';

import { Header } from '../components/Header.js';

const h = React.createElement;

export function PreflightScreen({ preflight, onBack, onNext, isActive: isActiveProp }) {
  const isActive = isActiveProp ?? Boolean(process.stdin && process.stdin.isTTY);

  useInput(
    (input, key) => {
      if (input.toLowerCase() === 'b') onBack?.();
      if (key.return && preflight?.ok) onNext?.();
    },
    { isActive }
  );

  const checks = preflight?.checks || [];
  const summary = useMemo(() => {
    const okCount = checks.filter((c) => c.ok).length;
    const failCount = checks.length - okCount;
    return { okCount, failCount };
  }, [checks]);

  const color = preflight?.ok ? 'green' : 'red';

  return h(
    Box,
    { flexDirection: 'column' },
    h(Header, { title: 'Preflight Checklist' }),
    h(
      Box,
      { borderStyle: 'round', borderColor: color, paddingX: 1, marginBottom: 1 },
      h(Text, { color, bold: true }, preflight?.ok ? 'READY' : 'BLOCKED'),
      h(Text, { dimColor: true }, `  (${summary.okCount} ok, ${summary.failCount} failed)`)
    ),
    h(
      Box,
      { flexDirection: 'column', marginBottom: 1 },
      ...checks.map((c, i) =>
        h(
          Box,
          { key: i, flexDirection: 'column', marginBottom: 1 },
          h(Text, { color: c.ok ? 'green' : 'red' }, `${c.ok ? 'OK' : 'FAIL'}  ${c.id}: ${c.message}`),
          !c.ok && c.fixHint ? h(Text, { dimColor: true }, `Hint: ${c.fixHint}`) : null
        )
      )
    ),
    h(
      Box,
      { flexDirection: 'row' },
      h(Text, { dimColor: true }, '[b] Back  '),
      h(Text, { dimColor: true }, preflight?.ok ? 'Enter → Confirm' : 'Fix issues then restart')
    )
  );
}
