#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 Grove Mail contributors
// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const temporary = mkdtempSync(join(tmpdir(), 'grove-cli-package-'));
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const calls = [];
const server = createServer(async (req, res) => {
  let body = ''; for await (const part of req) body += part;
  calls.push({ method: req.method, path: req.url, authorization: req.headers.authorization, body: body ? JSON.parse(body) : null });
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify(req.url === '/v0/agent/sign-up'
    ? { inbox_id: 'pack@example.invalid', organization_id: 'org_pack', api_key: 'gm_package_synthetic' }
    : { count: 1, inboxes: [{ inbox_id: 'pack@example.invalid' }] }));
});
try {
  const [archive] = JSON.parse(execFileSync(npm, ['pack', '--json', '--pack-destination', temporary], { cwd: root, encoding: 'utf8' }));
  const paths = archive.files.map(file => file.path);
  for (const file of ['dist/cli.js', 'dist/protocol.js', 'docs/reference/grove-mail-api.json', 'docs/reference/agentmail-openapi-1.5.0.json', 'docs/reference/agentmail-cli-discovery-1.5.0.json', 'LICENSE', 'NOTICE', 'THIRD_PARTY_NOTICES.md']) assert.ok(paths.includes(file), `Missing runtime asset: ${file}`);
  assert.ok(paths.every(path => path.startsWith('dist/') || path.startsWith('docs/reference/') && path.endsWith('.json') || ['package.json', 'README.md', 'LICENSE', 'NOTICE', 'docs/reference/README.md', 'docs/usage.md', 'THIRD_PARTY_NOTICES.md'].includes(path)), 'Unexpected packaged file');
  assert.ok(!paths.some(path => /server|deploy|sqlite|mailcow|private|\.env/.test(path)), 'Server/private files in package');
  const install = join(temporary, 'consumer'); mkdirSync(install);
  execFileSync(npm, ['install', '--prefix', install, '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', join(temporary, archive.filename)], { cwd: install, stdio: 'pipe' });
  const entry = join(install, 'node_modules/@opengrove/grove-mail-cli/dist/cli.js');
  const manifest = JSON.parse(readFileSync(join(install, 'node_modules/@opengrove/grove-mail-cli/package.json'), 'utf8'));
  assert.equal(manifest.license, 'Apache-2.0');
  for (const file of ['LICENSE', 'NOTICE', 'THIRD_PARTY_NOTICES.md']) assert.deepEqual(readFileSync(join(install, 'node_modules/@opengrove/grove-mail-cli', file)), readFileSync(join(root, file)), `Installed license material differs: ${file}`);
  assert.deepEqual(Object.keys(manifest.dependencies).sort(), ['dotenv', 'jmespath', 'undici', 'yaml']);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const run = (args, key) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [entry, ...args], {
      cwd: install, env: { PATH: process.env.PATH, TMPDIR: temporary, NO_PROXY: '*', GROVE_MAIL_CLIENT_CONFIG: join(temporary, 'unused.json'), GROVE_MAIL_BASE_URL: base, ...(key ? { GROVE_MAIL_API_KEY: key } : {}) }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', data => stdout += data); child.stderr.on('data', data => stderr += data);
    const timer = setTimeout(() => { child.kill(); reject(Error('Installed CLI timed out')); }, 15000);
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => { clearTimeout(timer); code === 0 ? resolve(stdout) : reject(Error(`Installed CLI failed (${code}): ${stderr}`)); });
  });
  assert.equal((await run(['--version'])).trim(), `grove-mail ${manifest.version}`);
  assert.equal(JSON.parse(await run(['--schema'])).operations.length, 140);
  assert.equal(JSON.parse(await run(['auth', 'status'])).schemes[0].logged_in, false);
  const inboxes = JSON.parse(await run(['inboxes', 'list'], 'gm_package_synthetic'));
  assert.equal(inboxes.inboxes[0].inbox_id, 'pack@example.invalid');
  const signup = JSON.parse(await run(['agent', 'sign-up', '--human-email', 'owner@example.invalid', '--username', 'pack']));
  assert.equal(signup.api_key, 'gm_package_synthetic');
  assert.deepEqual(calls.map(call => ({ method: call.method, path: call.path, authorization: call.authorization })), [
    { method: 'GET', path: '/v0/inboxes', authorization: 'Bearer gm_package_synthetic' },
    { method: 'POST', path: '/v0/agent/sign-up', authorization: undefined },
  ]);
  console.log(JSON.stringify({ passed: true, package: archive.filename, runtime_files: paths.length, official_operations: 140, synthetic_requests: calls.length, server_checkout_required: false }));
} finally {
  server.closeAllConnections(); server.close();
  rmSync(temporary, { recursive: true, force: true });
}
