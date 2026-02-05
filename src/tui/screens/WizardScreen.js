import React, { useMemo, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import SelectInput from 'ink-select-input';

import { Header } from '../components/Header.js';
import { KeyValueTable } from '../components/KeyValueTable.js';
import { redactConfig } from '../../config/redaction.js';

const h = React.createElement;

const SECTIONS = ['run', 'identity', 'plan', 'billing', 'safety', 'artifacts'];
const SECTION_LABELS = {
  run: 'Run/Execution',
  identity: 'Identity',
  plan: 'Plan',
  billing: 'Billing',
  safety: 'Safety',
  artifacts: 'Artifacts',
};

export function WizardScreen({ config, setConfig, onNext, onLoadYaml, onSaveYaml, isActive: isActiveProp }) {
  const isActive = isActiveProp ?? Boolean(process.stdin && process.stdin.isTTY);
  const [section, setSection] = useState('run');

  const configRedacted = redactConfig(config);

  useInput(
    (input, key) => {
      const lower = input.toLowerCase();
      if (key.return) {
        onNext?.();
        return;
      }

      if (lower === 'l') onLoadYaml?.();
      if (lower === 's') onSaveYaml?.();

      // Minimal in-TUI editing for the most common toggle.
      if (section === 'run' && lower === 'h') {
        setConfig?.((c) => ({
          ...c,
          run: {
            ...(c.run || {}),
            headless: !(c.run && c.run.headless),
          },
        }));
      }
    },
    { isActive }
  );

  const menuItems = useMemo(
    () =>
      SECTIONS.map((s) => ({
        label: SECTION_LABELS[s],
        value: s,
      })),
    []
  );

  const sectionRows = useMemo(() => {
    switch (section) {
      case 'run':
        return [
          ['Headless [h]', !!config.run?.headless],
          ['Stealth', !!config.run?.stealth],
          ['Max run (ms)', config.run?.maxRunMs],
          ['Step timeout (ms)', config.run?.stepTimeoutMs],
        ];
      case 'identity':
        return [
          ['Email', configRedacted.identity?.email || '(auto)'],
          ['Password', configRedacted.identity?.password || '(generated)'],
          ['OTP timeout (ms)', config.identity?.otpTimeoutMs],
        ];
      case 'plan':
        return [
          ['Seats', config.plan?.seats],
          ['Cadence', config.plan?.cadence],
        ];
      case 'billing':
        return [
          ['Card', configRedacted.billing?.cardNumber || '(auto)'],
          ['Exp month', configRedacted.billing?.expMonth || '—'],
          ['Exp year', configRedacted.billing?.expYear || '—'],
          ['CVC', configRedacted.billing?.cvc || '—'],
          ['ZIP', configRedacted.billing?.billingZip || '—'],
          ['Country', configRedacted.billing?.billingCountry || '—'],
        ];
      case 'safety':
        return [
          ['Confirm before subscribe', !!config.safety?.requireConfirmBeforeSubscribe],
          ['Persist secrets', !!config.safety?.persistSecrets],
        ];
      case 'artifacts':
        return [['Output dir', config.artifacts?.outputDir]];
      default:
        return [];
    }
  }, [section, config, configRedacted]);

  const previewRows = useMemo(() => {
    return [
      ['Email', configRedacted.identity?.email || '(auto)'],
      ['Password', configRedacted.identity?.password || '(generated)'],
      ['Card', configRedacted.billing?.cardNumber || '(auto)'],
      ['Headless', !!config.run?.headless],
      ['Stealth', !!config.run?.stealth],
      ['Seats', config.plan?.seats],
      ['Cadence', config.plan?.cadence],
      ['Confirm before subscribe', !!config.safety?.requireConfirmBeforeSubscribe],
      ['Artifacts dir', config.artifacts?.outputDir],
    ];
  }, [config, configRedacted]);

  return h(
    Box,
    { flexDirection: 'column' },
    h(Header, { title: 'Config Wizard' }),

    h(
      Box,
      { flexDirection: 'row', gap: 2 },
      h(
        Box,
        { flexDirection: 'column', width: 24, borderStyle: 'round', borderColor: 'gray', paddingX: 1 },
        h(Text, { bold: true }, 'Sections'),
        h(Text, { dimColor: true }, isActive ? '↑/↓ select' : '(non-interactive in tests)'),
        isActive
          ? h(SelectInput, {
              items: menuItems,
              initialIndex: Math.max(0, SECTIONS.indexOf(section)),
              onSelect: (item) => setSection(item.value),
            })
          : h(
              Box,
              { flexDirection: 'column', marginTop: 1 },
              ...menuItems.map((it) =>
                h(
                  Text,
                  { key: it.value, color: it.value === section ? 'cyan' : undefined },
                  `${it.value === section ? '>' : ' '} ${it.label}`
                )
              )
            )
      ),
      h(
        Box,
        { flexDirection: 'column', flexGrow: 1 },
        h(
          Box,
          { borderStyle: 'round', borderColor: 'gray', paddingX: 1, paddingY: 0, marginBottom: 1 },
          h(Text, { bold: true }, SECTION_LABELS[section]),
          h(Box, { flexDirection: 'column', marginTop: 1 }, h(KeyValueTable, { rows: sectionRows }))
        ),
        h(
          Box,
          { borderStyle: 'round', borderColor: 'gray', paddingX: 1 },
          h(Text, { bold: true }, 'Preview (redacted)'),
          h(Box, { flexDirection: 'column', marginTop: 1 }, h(KeyValueTable, { rows: previewRows }))
        )
      )
    ),

    h(
      Box,
      { marginTop: 1 },
      h(Text, { dimColor: true }, '[l] Load YAML  '),
      h(Text, { dimColor: true }, '[s] Save YAML  '),
      h(Text, { dimColor: true }, 'Enter → Preflight')
    )
  );
}
