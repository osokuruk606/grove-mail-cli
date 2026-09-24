import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { formatValue, project, validateQuery } from '../src/cli-output.js';
import { commandSchema, completion } from '../src/cli-discovery.js';
import { apiError, retryDelay } from '../src/cli-runtime.js';
import { officialOperations } from '../src/cli-contract.js';
import { cwd, isolated, mock, reply, run } from './cli-helpers.js';
const executable = process.env.AGENTMAIL_CLI ?? '';
const list = ['inboxes', 'messages', 'list', '--inbox-id', 'synthetic@example.invalid'];
const send = ['inboxes', 'messages', 'send', '--inbox-id', 'synthetic@example.invalid'];
const fixture = { count: 2, messages: [{ message_id: 'one', subject: 'First' }, { message_id: 'two', subject: 'Second' }] };
const pinned = JSON.parse(readFileSync(join(cwd, 'docs/reference/agentmail-cli-discovery-1.5.0.json'), 'utf8'));

test('discovery covers the pinned 140 operation input/output schemas and separates Grove additions', () => {
  assert.equal(commandSchema().operations.length, 140);
  assert.ok(commandSchema().groveExtensions.commands.includes('messages watch'));
  for (const op of officialOperations) assert.deepEqual(commandSchema(op.command), pinned.operations[op.command]);
  assert.deepEqual(commandSchema('inboxes messages'), pinned.root.operations.filter((v: any) => v.operation.startsWith('inboxes.messages.')));
  for (const shell of ['bash', 'zsh', 'fish', 'powershell', 'elvish']) assert.match(completion(shell), /grove-mail/);
});
test('JMESPath and collection formatters preserve projection and escaping', () => {
  assert.deepEqual(project(fixture, 'sort_by(messages, &subject)[].message_id'), ['one', 'two']);
  assert.throws(() => validateQuery('messages['));
  assert.equal(formatValue(fixture, 'jsonl'), '{"message_id":"one","subject":"First"}\n{"message_id":"two","subject":"Second"}\n');
  assert.deepEqual(parseYaml(formatValue({ text: 'yes:\n中文', empty: [], obj: {} }, 'yaml')), { text: 'yes:\n中文', empty: [], obj: {} });
  assert.equal(formatValue([{ a: 'one,"two"\nthree', b: null }], 'csv'), 'a,b\n"one,""two""\nthree",\n\n');
  assert.match(formatValue([{ nested: { name: '中文' }, a: ['one', 'two'] }], 'table'), /nested.name/);
  assert.ok(!formatValue([{ a: '\x1b[31m' }], 'table').includes('\x1b'));
});
test('retry policy distinguishes protocol idempotence, status retryability and exhaustion', () => {
  assert.equal(retryDelay(0, 503, 'POST', false), undefined);
  assert.equal(retryDelay(0, undefined, 'PATCH', false), undefined);
  assert.equal(retryDelay(0, 503, 'POST', true, '0'), 0);
  assert.equal(retryDelay(0, 429, 'POST', false, '2'), 2000);
  assert.equal(retryDelay(0, 408, 'PATCH', false, '0'), 0);
  assert.equal(retryDelay(3, 503, 'GET', true), undefined);
  assert.equal(retryDelay(0, 401, 'GET', true), undefined);
});
test('structured errors retain diagnostic fields while removing active credentials', () => {
  const value = apiError(400, JSON.stringify({ error: { code: 'bad_field', message: 'bad gm_very_secret', field: 'subject', api_key: 'opaque' } }), 'gm_very_secret').envelope();
  assert.equal(value.error.code, 400); assert.equal(value.error.reason, 'bad_field');
  assert.deepEqual(value.error.details, { error: { code: 'bad_field', field: 'subject', api_key: '[REDACTED]' } });
  assert.equal(value.error.message, 'bad [REDACTED]');
});

test('official v1.5.0 and Grove differential formatting, input and failure captures', { skip: !existsSync(executable) ? 'Set AGENTMAIL_CLI to the pinned 1.5.0 executable' : false }, async t => {
  const dir = isolated(t); writeFileSync(join(dir, 'body.txt'), 'Synthetic body\n'); writeFileSync(join(dir, 'bytes.bin'), Buffer.from([0, 1, 128, 255]));
  const cases: { args: string[]; status?: number; body?: any; request?: any }[] = [
    ...['json', 'jsonl', 'csv', 'table', 'yaml'].map(format => ({ args: [...list, '--format', format] })),
    { args: [...list, '--query', 'messages[].message_id'] },
    { args: [...list, '--subject', 'Hello, world'], request: { subject: ['Hello, world'] } },
    { args: [...send, '--to', '"Doe, Jane" <jane@example.invalid>', '--text', 'Synthetic'] },
    { args: [...send, '--subject', 'null', '--text', 'Synthetic'] },
    { args: ['api-keys', 'create', '--permissions.message-read', 'null'] },
    { args: [...send, '--json', '{"text":"@file://body.txt","attachments":[{"content":"@data://bytes.bin","filename":"bytes.bin"}]}'] },
    { args: [...send, '--headers', '{"X-Fixture":"@file://body.txt"}'] },
    { args: ['api-keys', 'create', '--permissions.message-read', 'true', '--permissions.message-send', 'false'] },
    { args: ['pods', 'domains', 'create', '--params', '{"pod_id":"synthetic"}', '--json', '{"domain":"example.invalid"}'] },
    { args: ['pods', 'inboxes', 'create', '--params', '{"pod_id":"synthetic"}'] },
    { args: [...list, '--limit', '2', '--params', '{"limit":1}'] },
    { args: [...list, '--ascending', 'True', '--limit', '002'] },
    { args: [...list, '--subject', '[todo'] },
    { args: [...send, '--to', '["one@example.invalid"]'] },
    { args: [...list, '--params', '{"limit":"2","ascending":1}'] },
    ...[400, 404, 422, 429].map(status => ({ args: list, status })),
    { args: [...list, '--quiet'], status: 400 },
    { args: [...list, '--format', 'jsonl'], status: 400 },
    { args: [...list, '--format', 'csv'], status: 400 },
    { args: [...list, '--format', 'raw'], status: 400 },
    { args: [...list, '--format', 'yaml'], status: 400 },
  ];
  for (const c of cases) await t.test(c.args.join(' ') + (c.status ? ` ${c.status}` : ''), async t => {
    const server = await mock(t, (_, res) => reply(res, c.status ? { error: { code: 'synthetic_error', message: 'Synthetic diagnostic', field: 'synthetic_field' } } : fixture, c.status));
    const results = [];
    for (const binary of [executable, undefined]) results.push(await run([...c.args, '--base-url', server.base, '--no-retry'], dir, {}, '', binary));
    assert.equal(results[1].code, results[0].code, results[1].stdout + results[1].stderr);
    assert.equal(results[1].stdout, results[0].stdout); assert.equal(results[1].stderr, results[0].stderr);
    assert.equal(server.calls.length, 2); assert.deepEqual(server.calls[1].body, server.calls[0].body);
    assert.deepEqual([...new URL(server.calls[1].url, server.base).searchParams].sort(), [...new URL(server.calls[0].url, server.base).searchParams].sort());
  });
});
test('process retry keeps one key/body, honors no-retry and never retries an unmarked POST 503', async t => {
  const dir = isolated(t);
  for (const [args, status, count] of [[list, 503, 2], [send, 503, 2], [['inboxes', 'create'], 503, 1], [['inboxes', 'create'], 429, 2], [[...list, '--no-retry'], 503, 1]] as [string[], number, number][]) {
    let n = 0; const server = await mock(t, (_, res) => { res.setHeader('retry-after', '0'); reply(res, ++n === 1 ? { error: { message: 'Retry fixture' } } : fixture, n === 1 ? status : 200); });
    const result = await run(args, dir, { GROVE_MAIL_BASE_URL: server.base }); assert.equal(server.calls.length, count); assert.equal(result.code, count === 1 ? 1 : 0);
    if (count === 2) { assert.equal(server.calls[1].headers['idempotency-key'], server.calls[0].headers['idempotency-key']); assert.deepEqual(server.calls[1].body, server.calls[0].body); }
  }
});
test('local validation, dotenv transport protection and auth status never accidentally call a service', async t => {
  const dir = isolated(t), server = await mock(t, (_, res) => reply(res, fixture));
  for (const args of [[...list, '--query', 'messages['], [...send, '--json', '{"text":"JSON"}', '--text', 'flag'], ['domains', 'create'], ['lists', 'list', '--direction', 'invalid', '--type', 'allow']]) {
    const result = await run(args, dir, { GROVE_MAIL_BASE_URL: server.base }); assert.equal(result.code, 3); assert.equal(JSON.parse(result.stdout).error.code, 400);
  }
  const status = await run(['auth', 'status', '--json'], dir); assert.equal(status.code, 0); assert.equal(JSON.parse(status.stdout).schemes[0].logged_in, true); assert.equal(server.calls.length, 0);
  writeFileSync(join(dir, '.env'), 'GROVE_MAIL_API_KEY=gm_dotenv_synthetic\nGROVE_MAIL_BASE_URL=https://never.example.invalid\nGROVE_MAIL_OUTPUT=jsonl\n');
  const result = await run(list, dir, { GROVE_MAIL_BASE_URL: server.base, GROVE_MAIL_API_KEY: undefined });
  assert.equal(result.code, 0); assert.equal(server.calls[0].headers.authorization, 'Bearer gm_dotenv_synthetic'); assert.equal(result.stdout.trim().split('\n').length, 2);
  assert.match(result.stderr, /Ignored transport\/execution settings/); assert.ok(!result.stderr.includes('gm_dotenv_synthetic'));
  assert.equal((await run(['inboxes', 'list', '--help'], dir)).stderr, '');
});
test('debug hides credentials and request contents; downloads stay bytes', async t => {
  const dir = isolated(t), server = await mock(t, (_, res) => reply(res, fixture));
  const result = await run([...send, '--text', 'private-mail-content', '--debug', '--user-agent-suffix', 'fixture/1.0'], dir, { GROVE_MAIL_BASE_URL: server.base });
  assert.equal(result.code, 0); assert.ok(!result.stderr.includes('gm_synthetic_cli_test')); assert.ok(!result.stderr.includes('private-mail-content')); assert.match(server.calls[0].headers['user-agent'], /fixture\/1.0/);
});

test('HTTP redirects preserve same-origin auth, reject cross-origin and strip it after explicit opt-in', async t => {
  const dir = isolated(t), external = await mock(t, (_, res) => reply(res, fixture));
  let location = '/fixture-next';
  const server = await mock(t, (req, res) => { if (req.url === '/fixture-next') reply(res, fixture); else { res.writeHead(302, { location }); res.end(); } });
  assert.equal((await run(['inboxes', 'list'], dir, { GROVE_MAIL_BASE_URL: server.base })).code, 0);
  assert.equal(server.calls[1].headers.authorization, 'Bearer gm_synthetic_cli_test');
  location = external.base + '/fixture';
  assert.equal((await run(['inboxes', 'list'], dir, { GROVE_MAIL_BASE_URL: server.base })).code, 3); assert.equal(external.calls.length, 0);
  assert.equal((await run(['inboxes', 'list'], dir, { GROVE_MAIL_BASE_URL: server.base, GROVE_MAIL_ALLOW_CROSS_HOST_REDIRECTS: '1' })).code, 0);
  assert.equal(external.calls[0].headers.authorization, undefined);
});

test('CLI builtins generate documents offline and watch projections retain durable cursors', async t => {
  const dir = isolated(t), generated = join(dir, 'skills');
  assert.equal((await run(['generate-skills', '--output-dir', generated, '--dry-run'], dir)).code, 0); assert.equal(existsSync(generated), false);
  const result = await run(['generate-skills', '--output-dir', generated], dir); assert.equal(result.code, 0);
  const files = JSON.parse(result.stdout).files; assert.equal(files.length, 30); assert.ok(files.every((path: string) => existsSync(path)));
  assert.match(readFileSync(join(generated, 'grove-mail-inboxes', 'SKILL.md'), 'utf8'), /inboxes messages send/);
  const cursor = join(dir, 'cursor'), server = await mock(t, (_, res) => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end('id: 9\nevent: message.received\ndata: {"event_id":"projected"}\n\n'); });
  const watch = await run(['messages', 'watch', '--inbox-id', 'synthetic@example.invalid', '--cursor-file', cursor, '--query', 'event_id', '--no-retry'], dir, { GROVE_MAIL_BASE_URL: server.base });
  assert.equal(watch.code, 0); assert.equal(watch.stdout, '"projected"\n'); assert.equal(readFileSync(cursor, 'utf8'), '9\n');
});
