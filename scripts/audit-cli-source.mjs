#!/usr/bin/env node
// Read-only comparison of the pinned official CLI and Grove against loopback fixtures.
// Never loads project credentials or calls an external service.
import { createServer } from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const root = fileURLToPath(new URL('..', import.meta.url));
const upstream = process.env.AGENTMAIL_SOURCE;
if (!upstream) throw new Error('Set AGENTMAIL_SOURCE to the unmodified AgentMail v1.5.0 source checkout.');
const official = process.env.AGENTMAIL_CLI;
if (!official) throw new Error('Set AGENTMAIL_CLI to the unmodified AgentMail 1.5.0 executable.');
if (!existsSync(official)) throw new Error('Install the pinned official agentmail-cli@1.5.0 first.');
const tag = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: upstream, encoding: 'utf8' }).trim();
if (tag !== '43ec9bfa1fc4c2641e80815e5c99246089b9ea8f') throw new Error('Upstream must be the audited v1.5.0 commit.');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const sourceSpec = readFileSync(join(upstream, 'cli/agentmail/openapi0.json'));
if (!sourceSpec.equals(readFileSync(join(root, 'docs/reference/agentmail-openapi-1.5.0.json')))) throw new Error('Pinned specifications differ.');
const fixture = { count: 2, messages: [{ message_id: 'synthetic-one', subject: 'First' }, { message_id: 'synthetic-two', subject: 'Second' }] };
const list = ['inboxes', 'messages', 'list', '--inbox-id', 'audit@example.invalid'];
const send = ['inboxes', 'messages', 'send', '--inbox-id', 'audit@example.invalid'];
const update = ['inboxes', 'messages', 'update', '--inbox-id', 'audit@example.invalid', '--message-id', 'synthetic-one', '--add-labels', 'seen'];
const cases = [
  { id: 'list-json', args: list },
  { id: 'quiet-http-error', args: [...list, '--quiet'], status: 400 },
  { id: 'jsonl-http-error', args: [...list, '--format', 'jsonl'], status: 422 },
  { id: 'csv-http-error', args: [...list, '--format', 'csv'], status: 400 },
  { id: 'yaml-http-error', args: [...list, '--format', 'yaml'], status: 400 },
  { id: 'jmespath-function', args: [...list, '--query', 'sort_by(messages, &subject)[].message_id'] },
  { id: 'invalid-jmespath', args: [...list, '--query', 'messages['] },
  { id: 'json-file-body', args: [...send, '--json', '@synthetic.json'] },
  { id: 'object-file-reference', args: [...send, '--headers', '{"X-Audit":"@file://synthetic.txt"}'] },
  { id: 'escaped-file-reference', args: [...send, '--json', '{"text":"\\\\@literal"}'] },
  { id: 'body-flag-conflict', args: [...send, '--json', '{"text":"from json"}', '--text', 'flag'] },
  { id: 'permission-leaf-flags', args: ['api-keys', 'create', '--permissions.message-read', 'true', '--permissions.message-send', 'false'] },
  { id: 'post-retry-503-idempotent', args: [...send, '--text', 'Synthetic'], retry: true, firstStatus: 503 },
  { id: 'post-no-retry-503', args: ['inboxes', 'create'], retry: true, firstStatus: 503 },
  { id: 'post-retry-429', args: ['inboxes', 'create'], retry: true, firstStatus: 429 },
  { id: 'patch-no-retry-503', args: update, retry: true, firstStatus: 503 },
  { id: 'missing-required-body', args: ['domains', 'create'] },
  { id: 'auth-login-help', args: ['auth', 'login', '--help'], offline: true },
  { id: 'man', args: ['man'], offline: true },
  { id: 'errors', args: ['errors', '--format', 'json'], offline: true },
  { id: 'list-jsonl', args: [...list, '--format', 'jsonl'] },
  { id: 'list-csv', args: [...list, '--format', 'csv'] },
  { id: 'list-table', args: [...list, '--format', 'table'] },
  { id: 'list-yaml', args: [...list, '--format', 'yaml'] },
  { id: 'response-query', args: [...list, '--query', 'messages[].message_id'] },
  { id: 'page-all-flag', args: [...list, '--page-all'], page: true },
  { id: 'grove-auto-pagination', args: [...list, '--all', '--format', 'jsonl'], page: true },
  { id: 'no-extract', args: [...list, '--no-extract'] },
  { id: 'comma-in-filter', args: [...list, '--subject', 'Hello, world'] },
  { id: 'comma-in-recipient-name', args: [...send, '--to', '"Doe, Jane" <jane@example.invalid>', '--text', 'Synthetic'] },
  { id: 'repeat-array', args: [...send, '--to', 'one@example.invalid', '--to', 'two@example.invalid', '--text', 'Synthetic'] },
  { id: 'nullable-string', args: [...send, '--to', 'one@example.invalid', '--subject', 'null', '--text', 'Synthetic'] },
  { id: 'nullable-object', args: [...send, '--to', 'one@example.invalid', '--headers', '{"X-Audit":"synthetic"}', '--text', 'Synthetic'] },
  { id: 'text-file-reference', args: [...send, '--to', 'one@example.invalid', '--text', '@file://synthetic.txt'] },
  { id: 'nested-file-reference', args: [...send, '--json', '{"to":["one@example.invalid"],"text":"@file://synthetic.txt","attachments":[{"filename":"synthetic.bin","content":"@data://synthetic.bin"}]}'] },
  { id: 'explicit-stdin-json', args: [...send, '--json', '-'], stdin: '{"to":["one@example.invalid"],"text":"Synthetic stdin"}' },
  { id: 'implicit-stdin-json', args: send, stdin: '{"to":["one@example.invalid"],"text":"Synthetic stdin"}' },
  { id: 'params-override', args: [...list, '--limit', '2', '--params', '{"limit":1}'] },
  { id: 'patch-idempotency', args: update },
  { id: 'patch-explicit-idempotency', args: [...update, '--idempotency-key', 'synthetic-patch'] },
  { id: 'delete-confirmation', args: ['inboxes', 'messages', 'delete', '--inbox-id', 'audit@example.invalid', '--message-id', 'synthetic-one'], status: 204 },
  { id: 'get-retry-503', args: list, retry: true, firstStatus: 503 },
  { id: 'get-no-retry-503', args: [...list, '--no-retry'], retry: true, firstStatus: 503 },
  { id: 'get-retry-429', args: list, retry: true, firstStatus: 429 },
  ...[400, 401, 403, 404].map(status => ({ id: `http-${status}`, args: list, status })),
  { id: 'raw-http-error', args: [...list, '--format', 'raw'], status: 400 },
  { id: 'missing-required-path', args: ['inboxes', 'messages', 'list'] },
  { id: 'shell-completion', args: ['completion', 'zsh'], offline: true },
  { id: 'version', args: ['--version'], offline: true },
  { id: 'root-schema', args: ['--schema'], offline: true },
  { id: 'list-help', args: [...list.slice(0, 3), '--help'], offline: true },
  { id: 'watch-discovery', args: ['inboxes', 'messages', 'watch', '--help'], offline: true },
  { id: 'download-descriptor', args: ['inboxes', 'messages', 'get-raw', '--inbox-id', 'audit@example.invalid', '--message-id', 'synthetic-one', '--output', '-'], descriptor: true },
];

const workspace = mkdtempSync(join(tmpdir(), 'grove-source-audit-'));
function run(binary, args, stdin, cwd) {
  return new Promise((resolveResult, reject) => {
    const child = spawn(binary === 'official' ? official : process.execPath,
      binary === 'official' ? args : ['--import', join(root, 'node_modules/tsx/dist/loader.mjs'), join(root, 'src/cli.ts'), ...args], {
        cwd, stdio: ['pipe', 'pipe', 'pipe'], env: {
          PATH: process.env.PATH, HOME: cwd, TMPDIR: workspace, XDG_CONFIG_HOME: cwd,
          GROVE_MAIL_CLIENT_CONFIG: join(cwd, 'unused-config.json'),
          AGENTMAIL_API_KEY: 'synthetic_audit_key', GROVE_MAIL_API_KEY: 'gm_synthetic_audit_key',
          AGENTMAIL_TIMEOUT_SECS: '5', NO_PROXY: '*', NO_COLOR: '1', CI: '1',
        },
      });
    let stdout = '', stderr = '';
    child.stdout.on('data', value => stdout += value);
    child.stderr.on('data', value => stderr += value);
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Audit subprocess timed out')); }, 15000);
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => {
      clearTimeout(timer);
      const clean = text => text.replace(/gm_synthetic_audit_key|synthetic_audit_key/g, '<synthetic-key>')
        .replace(/127\.0\.0\.1:\d+/g, '127.0.0.1:<fixture-port>')
        .replace(/"idempotency_key":"[a-f0-9-]{36}"/g, '"idempotency_key":"<generated-uuid>"');
      let jsonSummary;
      try { const value = JSON.parse(stdout); jsonSummary = { kind: Array.isArray(value) ? 'array' : typeof value, keys: value && !Array.isArray(value) && typeof value === 'object' ? Object.keys(value) : undefined, operations: value?.operations?.length, commands: value?.commands?.length }; } catch {}
      resolveResult({ exit_code: code, stdout: clean(stdout).slice(0, 7000), stderr: clean(stderr).slice(0, 7000), stdout_bytes: Buffer.byteLength(stdout), stdout_sha256: hash(stdout), ...(jsonSummary ? { json_summary: jsonSummary } : {}) });
    });
    child.stdin.end(stdin ?? '');
  });
}

const rows = [];
try {
  for (const probe of cases) {
    const row = { id: probe.id, arguments: probe.args, results: {} };
    for (const binary of ['official', 'grove']) {
      const calls = [];
      const server = createServer(async (req, res) => {
        let text = ''; for await (const chunk of req) text += chunk;
        calls.push({ method: req.method, path: req.url, body: text ? JSON.parse(text) : null,
          idempotency_key: req.headers['idempotency-key'] ? (req.headers['idempotency-key'].startsWith('synthetic-') ? req.headers['idempotency-key'] : '<generated-uuid>') : null });
        const status = calls.length === 1 && probe.firstStatus ? probe.firstStatus : probe.status ?? 200;
        if (req.url === '/synthetic-raw') { res.writeHead(200, { 'content-type': 'message/rfc822' }); res.end('Subject: synthetic\r\n\r\nSynthetic body\r\n'); return; }
        res.writeHead(status, { 'content-type': 'application/json', 'retry-after': '0' });
        if (status === 204) { res.end(); return; }
        let body = status >= 400 ? { error: { code: 'synthetic_error', message: 'Synthetic diagnostic', field: 'synthetic_field' } } : fixture;
        if (probe.descriptor) body = { download_url: `http://127.0.0.1:${server.address().port}/synthetic-raw` };
        if (probe.page) body = req.url.includes('page_token=synthetic-next') ? fixture : { ...fixture, next_page_token: 'synthetic-next' };
        res.end(JSON.stringify(body));
      });
      await new Promise(resolveListen => server.listen(0, '127.0.0.1', resolveListen));
      const cwd = join(workspace, `${probe.id}-${binary}`); mkdirSync(cwd);
      writeFileSync(join(cwd, 'synthetic.json'), '{"text":"Synthetic JSON file"}');
      writeFileSync(join(cwd, 'synthetic.txt'), 'Synthetic file body\n');
      writeFileSync(join(cwd, 'synthetic.bin'), Buffer.from([0, 1, 128, 255]));
      const args = [...probe.args];
      if (!probe.offline) {
        args.push('--base-url', `http://127.0.0.1:${server.address().port}`);
        if (!args.includes('--format')) args.push('--format', 'json');
        if (!probe.retry && !args.includes('--no-retry')) args.push('--no-retry');
      }
      try { row.results[binary] = { ...await run(binary, args, probe.stdin, cwd), request_count: calls.length, requests: calls }; }
      finally { server.closeAllConnections(); await new Promise(resolveClose => server.close(resolveClose)); }
    }
    const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(k => [k, canonical(value[k])])) : value;
    const requests = result => result.requests.map(call => { const url = new URL(call.path, 'http://fixture.invalid'); return canonical({ ...call, path: url.pathname, query: [...url.searchParams].sort() }); });
    row.comparison = { exit_equal: row.results.official.exit_code === row.results.grove.exit_code, requests_equal: JSON.stringify(requests(row.results.official)) === JSON.stringify(requests(row.results.grove)), stdout_equal: row.results.official.stdout === row.results.grove.stdout, stderr_equal: row.results.official.stderr === row.results.grove.stderr };
    rows.push(row);
    process.stdout.write(JSON.stringify({ id: row.id, official: { exit: row.results.official.exit_code, requests: row.results.official.request_count }, grove: { exit: row.results.grove.exit_code, requests: row.results.grove.request_count } }) + '\n');
  }
  const evidence = { version: 1, captured_at: new Date().toISOString(), scope: 'Synthetic local fixtures only; no hosted backend behavior or production compatibility is proven.',
    official_source: { tag: 'v1.5.0', commit: tag, spec_sha256: hash(sourceSpec) },
    grove_source: Object.fromEntries(['src/cli.ts', 'src/cli-contract.ts', 'src/cli-output.ts'].map(path => [path, hash(readFileSync(join(root, path)))])), rows };
  const output = resolve(root, process.env.CLI_AUDIT_OUTPUT ?? 'reports/cli-parity.json');
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, JSON.stringify(evidence, null, 2) + '\n');
  process.stdout.write(JSON.stringify({ output, probes: rows.length }) + '\n');
} finally { rmSync(workspace, { recursive: true, force: true }); }
