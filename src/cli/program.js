import { Command } from 'commander';

export function createProgram({ runTui, runHeadless }) {
  const program = new Command();
  program.name('signupx').description('ChatGPT trial provisioning operator tool');

  program
    .command('tui')
    .option('-c, --config <path>', 'config path', 'config.yaml')
    .action(async (opts) => runTui({ configPath: opts.config }));

  program
    .command('run')
    .option('-c, --config <path>', 'config path', 'config.yaml')
    .action(async (opts) => runHeadless({ configPath: opts.config }));

  return program;
}
