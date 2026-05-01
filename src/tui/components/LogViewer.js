import React from 'react';
import { Box, Text } from 'ink';

const h = React.createElement;

export function LogViewer({ events = [], title = 'Logs', maxLines = 10 }) {
  const lines = (events || []).slice(-maxLines);

  return h(
    Box,
    { flexDirection: 'column' },
    h(Text, { bold: true }, title),
    lines.length === 0
      ? h(Text, { dimColor: true }, '(no logs)')
      : h(
          Box,
          { flexDirection: 'column', marginTop: 1 },
          ...lines.map((ev, idx) =>
            h(
              Text,
              { key: idx, wrap: 'truncate-end' },
              h(Text, { dimColor: true }, `${new Date(ev.ts || 0).toLocaleTimeString()} `),
              h(
                Text,
                {
                  color:
                    ev.level === 'error'
                      ? 'red'
                      : ev.level === 'warn'
                        ? 'yellow'
                        : undefined,
                },
                `[${ev.level || 'info'}] ${ev.message}`
              )
            )
          )
        )
  );
}
