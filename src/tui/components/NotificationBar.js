import React from 'react';
import { Box, Text } from 'ink';

const h = React.createElement;

function colorForLevel(level) {
  if (level === 'error') return 'red';
  if (level === 'warn') return 'yellow';
  if (level === 'success') return 'green';
  return 'cyan';
}

export function NotificationBar({ notification }) {
  if (!notification) return null;
  const { level = 'info', message, detail } = notification;
  const color = colorForLevel(level);

  return h(
    Box,
    { borderStyle: 'single', borderColor: color, paddingX: 1, marginBottom: 1 },
    h(Text, { color, bold: true }, level.toUpperCase()),
    h(Text, null, `: ${message}`),
    detail ? h(Text, { dimColor: true }, ` (${detail})`) : null
  );
}
