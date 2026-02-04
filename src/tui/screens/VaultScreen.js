import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { Header } from '../components/Header.js';

const h = React.createElement;

const PROMPTS = {
  unlock: 'Enter passcode to unlock',
  create: 'Create a new passcode',
  confirm: 'Confirm passcode',
};

export function VaultScreen({ mode = 'unlock', error = null, onSubmit, onCancel, isActive: isActiveProp } = {}) {
  const isActive = isActiveProp ?? Boolean(process.stdin && process.stdin.isTTY);
  const [passcode, setPasscode] = useState('');

  useInput(
    (input, key) => {
      if (key.escape) {
        onCancel?.();
        return;
      }
      if (key.return) {
        if (passcode.length > 0) {
          onSubmit?.(passcode);
          setPasscode('');
        }
        return;
      }
      if (key.backspace || key.delete) {
        setPasscode((value) => value.slice(0, -1));
        return;
      }
      if (!key.ctrl && !key.meta && input) {
        setPasscode((value) => value + input);
      }
    },
    { isActive }
  );

  const masked = passcode.replace(/./g, '*');
  const prompt = PROMPTS[mode] || PROMPTS.unlock;

  return h(
    Box,
    { flexDirection: 'column' },
    h(Header, { title: 'Vault Passcode' }),
    h(Text, null, prompt),
    h(Text, { color: 'gray' }, masked || '•'.repeat(8)),
    error ? h(Text, { color: 'red' }, error) : null,
    h(
      Text,
      { dimColor: true },
      '[Enter] Submit  [Esc] Cancel'
    )
  );
}
