import React from 'react';
import { Box, Text } from 'ink';

const h = React.createElement;

function renderValue(v) {
  if (v === null || v === undefined) return '—';
  if (typeof v === 'boolean') return v ? 'Yes' : 'No';
  if (typeof v === 'number') return String(v);
  if (typeof v === 'string' && v.trim() === '') return '—';
  return String(v);
}

export function KeyValueTable({ rows = [], labelColor = 'gray' }) {
  if (!rows || rows.length === 0) return null;

  const maxKey = Math.min(
    28,
    rows.reduce((m, [k]) => Math.max(m, String(k).length), 0)
  );

  return h(
    Box,
    { flexDirection: 'column' },
    ...rows.map(([key, value]) =>
      h(
        Box,
        { key: String(key), flexDirection: 'row' },
        h(Text, { color: labelColor }, String(key).padEnd(maxKey)),
        h(Text, { dimColor: true }, '  '),
        h(Text, null, renderValue(value))
      )
    )
  );
}
