import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { Header } from '../components/Header.js';

import { redactConfig } from '../../config/redaction.js';

const h = React.createElement;

const SECTIONS = ['run', 'identity', 'plan', 'billing', 'safety', 'artifacts'];
const SECTION_LABELS = {
  run: 'Run/Execution',
  identity: 'Identity',
  plan: 'Plan',
  billing: 'Billing',
  safety: 'Safety',
  artifacts: 'Artifacts'
};

export function WizardScreen({ config, setConfig, onNext, onLoadYaml, onSaveYaml, isActive: isActiveProp }) {
  const isActive = isActiveProp ?? Boolean(process.stdin && process.stdin.isTTY);
  const [section, setSection] = useState('run');

  const configRedacted = redactConfig(config);

  useInput(
    (input, key) => {
      if (key.return) {
        onNext();
        return;
      }
      if (input.toLowerCase() === 'tab') {
        const idx = SECTIONS.indexOf(section);
        setSection(SECTIONS[(idx + 1) % SECTIONS.length]);
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

  const renderSectionContent = () => {
    switch (section) {
      case 'run':
        return h(Box, { flexDirection: 'column' },
          h(Text, null, '[h] Headless: ', h(Text, { color: config.run?.headless ? 'green' : 'red' }, String(config.run?.headless))),
          h(Text, null, `Max Run (ms): ${config.run?.maxRunMs}`),
          h(Text, null, `Step Timeout (ms): ${config.run?.stepTimeoutMs}`)
        );
      case 'identity':
        return h(Box, { flexDirection: 'column' },
          h(Text, null, `Email: ${configRedacted.identity?.email || '(auto)'}`),
          h(Text, null, `Password: ${configRedacted.identity?.password || '(none)'}`)
        );
      case 'plan':
        return h(Box, { flexDirection: 'column' },
          h(Text, null, `Tier: ${config.plan?.tier || 'free'}`)
        );
      case 'billing':
        return h(Box, { flexDirection: 'column' },
          h(Text, null, `Method: ${config.billing?.method || 'none'}`),
          h(Text, null, `Card: ${configRedacted.billing?.cardNumber || 'N/A'}`)
        );
      case 'safety':
        return h(Box, { flexDirection: 'column' },
          h(Text, null, `Enabled: ${config.safety?.enabled ? 'Yes' : 'No'}`)
        );
      case 'artifacts':
        return h(Box, { flexDirection: 'column' },
          h(Text, null, `Output Dir: ${config.artifacts?.outputDir}`)
        );
      default:
        return null;
    }
  };

  return h(
    Box,
    { flexDirection: 'column' },
    h(Header, { title: 'Config Wizard' }),
    h(
      Box,
      { marginBottom: 1, flexWrap: 'wrap' },
      SECTIONS.map(s => h(
        Text,
        { key: s, backgroundColor: section === s ? 'blue' : undefined, marginRight: 1 },
        ` [ ${SECTION_LABELS[s]} ] `
      ))
    ),
    h(
      Box,
      { borderStyle: 'round', paddingX: 1, marginBottom: 1, minHeight: 5 },
      renderSectionContent()
    ),
    h(
      Box,
      { flexDirection: 'column', borderStyle: 'single', borderColor: 'gray', paddingX: 1, marginBottom: 1 },
      h(Text, { bold: true }, 'PREVIEW (REDACTED)'),
      h(Text, { dimColor: true }, JSON.stringify(configRedacted, null, 2))
    ),
    h(Box, { flexDirection: 'row' },
      h(Text, { dimColor: true }, '[l] Load YAML  '),
      h(Text, { dimColor: true }, '[s] Save YAML  '),
      h(Text, { dimColor: true }, '[Tab] Switch Section  '),
      h(Text, { dimColor: true }, 'Enter → Preflight')
    )
  );
}
