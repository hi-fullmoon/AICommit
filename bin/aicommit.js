#!/usr/bin/env node

import chalk from 'chalk';

import { main } from '../src/main.js';

main().catch((err) => {
  console.error('\n  ' + chalk.red(`✗ ${err.message}\n`));
  process.exit(1);
});
