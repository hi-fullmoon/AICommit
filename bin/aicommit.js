#!/usr/bin/env node

import chalk from 'chalk';

import { main } from '../src/main.js';
import { sanitizeTerminalText } from '../src/utils.js';

main().catch((err) => {
  console.error('\n  ' + chalk.red(`✗ ${sanitizeTerminalText(err?.message || err)}\n`));
  process.exit(1);
});
