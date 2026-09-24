#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 Grove Mail contributors
// SPDX-License-Identifier: Apache-2.0
// Every pinned operation against loopback. This verifies CLI construction, never backend semantics.
import { createServer } from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { officialOperations, type Shape, specText } from '../src/cli-contract.js';
import { commandSchema } from '../src/cli-discovery.js';
const root = fileURLToPath(new URL('..', import.meta.url));
const executable = process.env.AGENTMAIL_CLI;
if (!executable) throw new Error('Set AGENTMAIL_CLI to the unmodified AgentMail 1.5.0 executable.');
const workspace = mkdtempSync(join(tmpdir(), 'grove-all-operations-'));
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const canonical = (value: any): any => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(k => [k, canonical(value[k])])) : value;
function example(shape: Shape = {}, name = ''): any {
  if (shape.const !== undefined) return shape.const;
  if (shape.enum?.length) return shape.enum[0];
  if (shape.oneOf || shape.anyOf) return example((shape.oneOf ?? shape.anyOf).find((v: any) => v.type !== 'null'), name);
  if (shape.type === 'object' || shape.properties) return Object.fromEntries((shape.required ?? []).map((k: string) => [k, example(shape.properties?.[k], k)]));
  if (shape.type === 'array') return Array.from({ length: Math.max(1, shape.minItems ?? 0) }, () => example(shape.items, name));
  if (shape.type === 'boolean') return true;
  if (['number', 'integer'].includes(shape.type)) return Math.max(1, shape.minimum ?? 0);
  if (shape.format === 'date-time') return '2026-01-02T03:04:05Z';
  if (name.includes('url')) return 'https://example.invalid/fixture';
  if (name.includes('email') || name === 'inbox_id') return 'synthetic@example.invalid';
  if (name === 'domain') return 'example.invalid';
  return 'synthetic'.repeat(Math.ceil(Math.max(9, shape.minLength ?? 0) / 9)).slice(0, shape.maxLength ?? Math.max(9, shape.minLength ?? 0));
}
function run(official: boolean, args: string[], cwd: string) {
  return new Promise<{ exit: number | null; stdout: string; stderr: string }>((resolveRun, reject) => {
    const child = spawn(official ? executable : process.execPath, official ? args : ['--import', join(root, 'node_modules/tsx/dist/loader.mjs'), join(root, 'src/cli.ts'), ...args], {
      cwd, stdio: ['pipe', 'pipe', 'pipe'], env: { PATH: process.env.PATH, HOME: cwd, XDG_CONFIG_HOME: cwd, TMPDIR: workspace, GROVE_MAIL_CLIENT_CONFIG: join(cwd, 'synthetic-config.json'), GROVE_MAIL_API_KEY: 'gm_synthetic_matrix_key', AGENTMAIL_API_KEY: 'synthetic_matrix_key', AGENTMAIL_TIMEOUT_SECS: '5', GROVE_MAIL_TIMEOUT_SECS: '5', NO_PROXY: '*', NO_COLOR: '1' }
    });
    let stdout = '', stderr = ''; child.stdout.on('data', v => stdout += v); child.stderr.on('data', v => stderr += v); child.stdin.end();
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(Error('CLI timed out')); }, 15000);
    child.on('error', reject); child.on('close', exit => { clearTimeout(timer); resolveRun({ exit, stdout: stdout.replaceAll('synthetic_matrix_key', '<synthetic-key>'), stderr: stderr.replaceAll('synthetic_matrix_key', '<synthetic-key>') }); });
  });
}
try {
  const version = execFileSync(executable, ['--version'], { cwd: workspace, env: { PATH: process.env.PATH, HOME: workspace, XDG_CONFIG_HOME: workspace }, encoding: 'utf8' }).trim();
  if (version !== 'agentmail 1.5.0') throw Error('Only the pinned AgentMail 1.5.0 CLI may produce this fixture.');
  const rows: any[] = new Array(officialOperations.length); let next = 0;
  await Promise.all(Array.from({ length: 4 }, async () => {
    for (;;) {
      const index = next++; if (index >= officialOperations.length) return;
      const op = officialOperations[index], input = commandSchema(op.command).input, params: Record<string, any> = {};
      for (const [name, field] of Object.entries(input.properties) as [string, any][]) if (field.location === 'path' || field.location === 'query' && input.required?.includes(name)) params[name] = example(field, name);
      const args = [...op.command.split(' '), '--params', JSON.stringify(params)];
      if (op.body?.required?.length) args.push('--json', JSON.stringify(example(op.body)));
      const captures: any[] = [];
      for (const official of [true, false]) {
        const requests: any[] = [];
        const server = createServer(async (req, res) => {
          let body = ''; for await (const chunk of req) body += chunk;
          const url = new URL(req.url!, 'http://fixture.invalid');
          requests.push(canonical({ method: req.method, path: url.pathname, query: [...url.searchParams].sort(), body: body ? JSON.parse(body) : null, bearer_present: /^Bearer /.test(req.headers.authorization ?? ''), idempotency_key_present: Boolean(req.headers['idempotency-key']) }));
          res.writeHead(200, { 'content-type': 'application/json' }); res.end('{}');
        });
        await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
        const dir = join(workspace, `${index}-${official ? 'official' : 'grove'}`); mkdirSync(dir);
        try { captures.push({ ...await run(official, [...args, '--base-url', `http://127.0.0.1:${(server.address() as any).port}`, '--no-retry', '--format', 'json', ...(!official && op.method === 'DELETE' ? ['--confirmed'] : [])], dir), requests }); }
        finally { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); }
      }
      const [official, grove] = captures;
      const passed = official.exit === 0 && grove.exit === 0 && official.requests.length === 1 && grove.requests.length === 1 && JSON.stringify(official.requests) === JSON.stringify(grove.requests);
      rows[index] = { operation_id: op.operationId, command: op.command, method: op.method, arguments: args, grove_delete_confirmation: op.method === 'DELETE', passed, official, grove };
      if (!passed) process.stderr.write(JSON.stringify({ operation: op.command, official, grove }) + '\n');
    }
  }));
  const output = join(root, 'reports/cli-operations.json');
  mkdirSync(join(root, 'reports'), { recursive: true });
  const report = { scope: 'All 140 CLI operations send one matching synthetic loopback request. Fixture responses do not validate backend behavior or response schemas. Grove DELETE explicitly confirms its synthetic target.', official_version: version, spec_sha256: hash(specText), source_sha256: Object.fromEntries(['src/cli.ts', 'src/cli-contract.ts', 'src/cli-discovery.ts', 'src/cli-runtime.ts', 'src/cli-output.ts'].map(path => [path, hash(readFileSync(join(root, path)))])), passed: rows.filter(v => v.passed).length, total: rows.length, rows };
  writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ passed: report.passed, total: report.total, output })); if (report.passed !== report.total) process.exitCode = 1;
} finally { rmSync(workspace, { recursive: true, force: true }); }
