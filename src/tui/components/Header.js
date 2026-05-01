import React from 'react';
import { Box, Text } from 'ink';

export function Header({ title }) {
  return React.createElement(
    Box,
    { borderStyle: 'single', borderColor: 'cyan', paddingX: 1, marginBottom: 1 },
    React.createElement(Text, { bold: true, color: 'cyan' }, title)
  );
}
