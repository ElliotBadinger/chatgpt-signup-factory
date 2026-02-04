import { jest } from '@jest/globals';
import { createProgram } from '../src/cli/program.js';

it('dispatches signupx tui with config path', async () => {
  const runTui = jest.fn().mockResolvedValue();
  const runHeadless = jest.fn().mockResolvedValue();
  const program = createProgram({ runTui, runHeadless });

  await program.parseAsync(['tui', '--config', 'cfg.yml'], { from: 'user' });

  expect(runTui).toHaveBeenCalledWith(expect.objectContaining({ configPath: 'cfg.yml' }));
});

it('dispatches signupx run with config path', async () => {
  const runTui = jest.fn().mockResolvedValue();
  const runHeadless = jest.fn().mockResolvedValue();
  const program = createProgram({ runTui, runHeadless });

  await program.parseAsync(['run', '--config', 'cfg.yml'], { from: 'user' });

  expect(runHeadless).toHaveBeenCalledWith(expect.objectContaining({ configPath: 'cfg.yml' }));
});
