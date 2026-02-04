#!/usr/bin/env node
import { createProgram } from './program.js';
import { runTui } from '../tui/entrypoint.js';
import { runHeadless } from './runHeadless.js';

const program = createProgram({ runTui, runHeadless });
program.parseAsync(process.argv);
