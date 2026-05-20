#!/usr/bin/env node
import { parseClassRewardArgs, renderCliResult } from './cli.ts';

const result = parseClassRewardArgs(process.argv.slice(2));
process.stdout.write(`${renderCliResult(result)}\n`);
