#!/usr/bin/env node
// Offline, pinned CLI metadata. Uses isolated home/config and no real credential sources.
import { execFileSync } from 'node:child_process';
import { existsSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('..', import.meta.url));
const executable = process.env.AGENTMAIL_CLI;
if (!executable) throw new Error('Set AGENTMAIL_CLI to the unmodified AgentMail 1.5.0 executable.');
const dir = mkdtempSync(join(tmpdir(), 'grove-cli-discovery-'));
const run = args => execFileSync(executable, args, { cwd: dir, encoding: 'utf8', env: { PATH: process.env.PATH, HOME: dir, XDG_CONFIG_HOME: dir, NO_COLOR: '1', AGENTMAIL_API_KEY: 'synthetic_capture_key' } });
try {
  const version = run(['--version']).trim(); if (version !== 'agentmail 1.5.0') throw Error(`Unexpected pinned CLI version: ${version}`);
  const rootSchema = JSON.parse(run(['--schema']));
  const operations = Object.fromEntries(rootSchema.operations.map(op => [op.operation.replaceAll('.', ' '), JSON.parse(run([...op.operation.split('.'), '--schema']))]));
  writeFileSync(join(root, 'docs/reference/agentmail-cli-discovery-1.5.0.json'), JSON.stringify({ version, root: rootSchema, operations }, null, 2) + '\n');
  console.log(`Captured ${Object.keys(operations).length} operation schemas from ${version}; no HTTP requests.`);
} finally { rmSync(dir, { recursive: true, force: true }); }
