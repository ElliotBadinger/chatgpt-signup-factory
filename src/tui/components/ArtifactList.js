import React from 'react';
import { Box, Text } from 'ink';

export function ArtifactList({ artifacts }) {
  if (!artifacts || artifacts.length === 0) {
    return React.createElement(Text, { dimColor: true }, '(no artifacts yet)');
  }

  return React.createElement(
    Box,
    { flexDirection: 'column' },
    ...artifacts.map((a, i) => React.createElement(Text, { key: i, wrap: 'truncate-end' }, `- ${a}`))
  );
}
