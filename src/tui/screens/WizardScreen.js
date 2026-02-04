import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { Header } from '../components/Header.js';

const h = React.createElement;

export function WizardScreen({ config, setConfig, onNext, onLoadYaml, onSaveYaml, isActive: isActiveProp }) {
  const isActive = isActiveProp ?? Boolean(process.stdin && process.stdin.isTTY);
  const [section, setSection] = useState('run'); // 'run' or 'identity'

  useInput(
    (input, key) => {
      if (key.return) {
        onNext();
        return;
      }
      if (input.toLowerCase() === 'tab') {
        setSection(s => s === 'run' ? 'identity' : 'run');
      }
      if (input.toLowerCase() === 'l') {
        onLoadYaml?.();
      }
      if (input.toLowerCase() === 's') {
        onSaveYaml?.();
      }
      
      if (section === 'run') {
        if (input.toLowerCase() === 'h') {
          setConfig((c) => ({ ...c, run: { ...c.run, headless: !c.run.headless } }));
        }
      }
    },
    { isActive }
  );

  return h(
    Box,
    { flexDirection: 'column' },
    h(Header, { title: 'Config Wizard' }),
    h(
      Box,
      { marginBottom: 1 },
      h(Text, { backgroundColor: section === 'run' ? 'blue' : undefined }, ' [ Run Settings ] '),
      h(Text, { backgroundColor: section === 'identity' ? 'blue' : undefined }, ' [ Identity ] ')
    ),
    section === 'run' ? h(
      Box,
      { flexDirection: 'column' },
      h(
        Text,
        null,
        '[h] Headless: ',
        h(Text, { color: config.run?.headless ? 'green' : 'red' }, String(config.run?.headless))
      )
    ) : h(
      Box,
      { flexDirection: 'column' },
      h(Text, null, 'Password: [REDACTED]')
    ),
    h(Text, null, ' '),
    h(Box, { flexDirection: 'row' },
      h(Text, { dimColor: true }, '[l] Load YAML  '),
      h(Text, { dimColor: true }, '[s] Save YAML  '),
      h(Text, { dimColor: true }, '[Tab] Switch Section  '),
      h(Text, { dimColor: true }, 'Enter → Preflight')
    )
  );
}
