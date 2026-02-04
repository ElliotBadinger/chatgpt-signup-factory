import React from 'react';
import { Box, Text, useInput } from 'ink';
import { Header } from '../components/Header.js';

const h = React.createElement;

export function ConfirmScreen({ configRedacted, onBack, onStart }) {
  const isActive = Boolean(process.stdin && process.stdin.isTTY);

  useInput(
    (input, key) => {
      if (input.toLowerCase() === 'b') onBack();
      if (key.return) onStart();
    },
    { isActive }
  );

  return h(
    Box,
    { flexDirection: 'column' },
    h(Header, { title: 'Confirm & Start' }),
    h(Text, { dimColor: true }, 'Redacted config preview:'),
    h(
      Box,
      { borderStyle: 'round', borderColor: 'gray', paddingX: 1, marginY: 1 },
      h(Text, null, JSON.stringify(configRedacted, null, 2))
    ),
    h(Box, { flexDirection: 'row' },
      h(Text, { dimColor: true }, '[b] Back  '),
      h(Text, { dimColor: true }, 'Enter → Start run')
    )
  );
}
