// SPDX-FileCopyrightText: 2026 Grove Mail contributors
// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { cliOperations, officialOperations, specText } from '../src/cli-contract.js';
import { isolated, mock, reply, run, launch } from './cli-helpers.js';

test('first-time signup needs no existing key; login and verification use the returned credential', async t => {
  const dir = isolated(t), issued = 'gm_signup_synthetic';
  const server = await mock(t, (req, res) => reply(res, req.url === '/v0/agent/sign-up'
    ? { organization_id: 'org_signup', inbox_id: 'new-agent@example.com', api_key: issued }
    : { verified: true }));
  const env = { GROVE_MAIL_BASE_URL: server.base, GROVE_MAIL_API_KEY: '' };
  const signup = await run(['agent', 'sign-up', '--username', 'new-agent', '--human-email', 'owner@example.com'], dir, env);
  assert.equal(signup.code, 0, signup.stderr);
  assert.equal(server.calls[0].method, 'POST');
  assert.equal(server.calls[0].url, '/v0/agent/sign-up');
  assert.equal(server.calls[0].headers.authorization, undefined);
  assert.deepEqual(server.calls[0].body, { username: 'new-agent', human_email: 'owner@example.com' });
  const key = JSON.parse(signup.stdout).api_key;
  for (const args of [['inboxes', 'list'], ['agent', 'verify', '--otp-code', '123456']]) {
    assert.equal((await run(args, dir, env)).code, 2);
  }
  assert.equal(server.calls.length, 1, 'Protected operations must still require credentials');
  const login = await run(['auth', 'login', '--with-token'], dir, env, key);
  assert.equal(login.code, 0, login.stderr);
  assert.equal(statSync(join(dir, 'config.json')).mode & 0o777, 0o600);
  assert.ok(!login.stdout.includes(issued));
  const verify = await run(['agent', 'verify', '--otp-code', '123456'], dir, { GROVE_MAIL_API_KEY: undefined });
  assert.equal(verify.code, 0, verify.stderr);
  assert.equal(server.calls[1].headers.authorization, `Bearer ${issued}`);
  assert.deepEqual(server.calls[1].body, { otp_code: '123456' });
});

test('CLI discovers all 140 pinned operations and official nested help/schema without credentials', async t => {
  const dir = isolated(t); writeFileSync(join(dir, 'config.json'), 'invalid config should not be read');
  assert.equal(createHash('sha256').update(specText).digest('hex'), '091ff0ff81360af1e248e03d49272e038f36e0cd2932067ce28fa512fdeeb6ce');
  assert.equal(officialOperations.length, 140); assert.equal(new Set(officialOperations.map(o => o.command)).size, 140);
  const schema = await run(['schema'], dir); assert.equal(schema.code, 0); assert.equal(JSON.parse(schema.stdout).cli_operations.filter((v: any) => v.operationId).length, 140);
  for (const args of [['inboxes', 'messages', '--help'], ['pods', 'api-keys', 'create', '--schema'], ['spec']]) assert.equal((await run(args, dir, { GROVE_MAIL_API_KEY: '' })).code, 0);
  for (const operation of officialOperations) assert.ok(cliOperations().find(o => o.command === operation.command));
});
test('strict usage, dry-run including watch/auth/delete, and repeated parameters do not issue requests', async t => {
  const dir = isolated(t), server = await mock(t, (_, res) => reply(res, {})), env = { GROVE_MAIL_BASE_URL: server.base };
  for (const args of [
    ['messages', 'sned'], ['messages', 'send', '--typo', 'x'], ['messages', 'send', '--dry-run=nah'],
    ['inboxes', 'update', '--inbox', 'a@example.com', '--active', 'yes'],
    ['inboxes', 'list', '--limti', '1'], ['messages', 'list', '--inbox', 'a@example.com', 'surplus'],
    ['messages', 'watch', '--inbox', 'a@example.com', '--aftr', '1'], ['auth', 'status', '--typo', 'x'],
    ['inboxes', 'get', '--inbox', 'a@example.com', '--inbox-id', 'b@example.com'],
    ['messages', 'delete', '--inbox', 'a@example.com', '--message', 'm', '--confirmed=false']
  ]) assert.equal((await run(args, dir, env)).code, 3, args.join(' '));
  for (const args of [
    ['messages', 'watch', '--inbox', 'a@example.com', '--after', '0'],
    ['auth', 'login', '--key-file', '/must-not-be-read'], ['auth', 'logout'], ['auth', 'status'],
    ['messages', 'delete', '--inbox', 'a@example.com', '--message', 'm']
  ]) assert.equal((await run([...args, '--dry-run'], dir, env)).code, 0);
  assert.equal(server.calls.length, 0);
  assert.equal((await run(['inboxes', 'list', '--base-url', 'http://example.com'], dir)).code, 3);
});
test('real process sends stdin JSON/body files, repeated arrays, native files and auth headers', async t => {
  const dir = isolated(t), server = await mock(t, (_, res) => reply(res, { message_id: 'm', thread_id: 't' })), env = { GROVE_MAIL_BASE_URL: server.base };
  const text = '原文\n unchanged  \n', bytes = Buffer.from([0, 1, 128, 255]);
  writeFileSync(join(dir, 'text.txt'), text); writeFileSync(join(dir, 'file.bin'), bytes);
  let result = await run(['inboxes', 'messages', 'send', '--inbox-id', 'a+tag@example.com', '--to', 'a@example.com', '--to', '["b@example.com","c@example.com"]', '--text-file', join(dir, 'text.txt'), '--attach', join(dir, 'file.bin'), '--idempotency-key', 'safe-key'], dir, env);
  assert.equal(result.code, 0, result.stderr); assert.equal(server.calls[0].url, '/v0/inboxes/a%2Btag%40example.com/messages/send');
  assert.equal(server.calls[0].headers.authorization, 'Bearer gm_synthetic_cli_test'); assert.equal(server.calls[0].headers['idempotency-key'], 'safe-key');
  assert.deepEqual(server.calls[0].body.to, ['a@example.com', 'b@example.com', 'c@example.com']); assert.equal(server.calls[0].body.text, text); assert.deepEqual(Buffer.from(server.calls[0].body.attachments[0].content, 'base64'), bytes);
  result = await run(['messages', 'send', '--inbox', 'a@example.com', '--json', '-'], dir, env, '{"to":["a@example.com"],"text":"stdin"}'); assert.equal(result.code, 0); assert.equal(server.calls[1].body.text, 'stdin');
  writeFileSync(join(dir, 'body.json'), '{"to":["a@example.com"],"text":"file"}');
  assert.equal((await run(['messages', 'send', '--inbox', 'a@example.com', '--body-file', join(dir, 'body.json')], dir, env)).code, 0); assert.equal(server.calls[2].body.text, 'file');
  result = await run(['messages', 'send', '--inbox', 'a@example.com', '--to', 'a@example.com', '--text-file', '-'], dir, env, text); assert.equal(result.code, 0); assert.equal(server.calls[3].body.text, text);
  assert.ok(!result.stdout.includes('gm_synthetic')); assert.ok(!result.stderr.includes('gm_synthetic'));
});
test('HTTP auth/not-found errors keep exit status and never retry even watch', async t => {
  const dir = isolated(t);
  for (const status of [401, 403, 404]) {
    const server = await mock(t, (_, res) => reply(res, { message: 'private server echo', error: { message: 'gm_synthetic_cli_test' } }, status));
    for (const args of [['inboxes', 'list'], ['messages', 'watch', '--inbox', 'a@example.com']]) {
      const result = await run(args, dir, { GROVE_MAIL_BASE_URL: server.base });
      assert.equal(result.code, 1); assert.equal(JSON.parse(args.at(-1) === 'a@example.com' ? result.stderr : result.stdout).error.code, status); assert.ok(!result.stderr.includes('gm_synthetic_cli_test'));
    }
    assert.equal(server.calls.length, 2);
  }
});
test('pagination preserves repeated query arrays and bounds broken cursors', async t => {
  const dir = isolated(t), server = await mock(t, (req, res) => reply(res, req.url?.includes('page_token=next') ? { messages: [{ message_id: 'two' }] } : { messages: [{ message_id: 'one' }], next_page_token: 'next' }));
  let result = await run(['inboxes', 'messages', 'list', '--inbox-id', 'a@example.com', '--labels', 'one', '--labels', 'two', '--ascending', 'false', '--all', '--format', 'jsonl'], dir, { GROVE_MAIL_BASE_URL: server.base });
  assert.equal(result.code, 0, result.stderr); assert.equal(result.stdout.trim().split('\n').length, 2); assert.equal(server.calls.length, 2);
  const url = new URL(server.calls[1].url, server.base); assert.deepEqual(url.searchParams.getAll('labels'), ['one', 'two']); assert.equal(url.searchParams.get('ascending'), 'false');
  const loop = await mock(t, (_, res) => reply(res, { messages: [], next_page_token: 'same' }));
  result = await run(['inboxes', 'messages', 'list', '--inbox-id', 'a@example.com', '--all'], dir, { GROVE_MAIL_BASE_URL: loop.base }); assert.equal(result.code, 1); assert.equal(loop.calls.length, 2); assert.match(result.stderr, /pagination_loop/);
});
test('binary raw/attachments remain byte exact and empty DELETE succeeds with explicit confirmation', async t => {
  const dir = isolated(t), bytes = Buffer.from([0, 13, 10, 127, 128, 255]);
  const server = await mock(t, (req, res) => { if (req.method === 'DELETE') { res.writeHead(204); res.end(); } else { res.writeHead(200, { 'content-type': 'application/octet-stream' }); res.end(bytes); } });
  for (const args of [['messages', 'raw', '--message', 'm'], ['attachments', 'get', '--message', 'm', '--attachment', '0']]) {
    const out = join(dir, 'binary'); const result = await run([...args, '--inbox', 'a@example.com', '--output', out], dir, { GROVE_MAIL_BASE_URL: server.base });
    assert.equal(result.code, 0); assert.deepEqual(readFileSync(out), bytes); assert.equal(statSync(out).mode & 0o777, 0o600);
  }
  const result = await run(['messages', 'delete', '--inbox', 'a@example.com', '--message', 'm', '--confirmed'], dir, { GROVE_MAIL_BASE_URL: server.base }); assert.equal(result.code, 0); assert.equal(result.stdout, 'null\n');
});
test('output formats and auth persistence/logout work through real processes', async t => {
  const dir = isolated(t), server = await mock(t, (_, res) => reply(res, [{ id: 'a', text: 'hello, "quoted"' }, { id: 'b' }]));
  for (const format of ['json', 'jsonl', 'yaml', 'csv', 'table', 'raw', 'http']) {
    const result = await run(['inboxes', 'list', '--format', format], dir, { GROVE_MAIL_BASE_URL: server.base }); assert.equal(result.code, 0); assert.ok(result.stdout.includes('a')); if (format === 'jsonl') assert.equal(result.stdout.trim().split('\n').length, 2);
  }
  assert.equal((await run(['inboxes', 'list', '--quiet'], dir, { GROVE_MAIL_BASE_URL: server.base })).stdout, '');
  const result = await run(['auth', 'login', '--key-file', '-', '--base-url', server.base], dir, {}, 'gm_saved_synthetic'); assert.equal(result.code, 0); assert.ok(!result.stdout.includes('gm_saved')); assert.equal(statSync(join(dir, 'config.json')).mode & 0o777, 0o600);
  const status = await run(['auth', 'status'], dir, { GROVE_MAIL_API_KEY: undefined }); assert.equal(status.code, 0); assert.equal(JSON.parse(status.stdout).schemes[0].sources[1].state, 'active');
  assert.equal((await run(['inboxes', 'list'], dir, { GROVE_MAIL_API_KEY: undefined })).code, 0);
  assert.equal(server.calls.at(-1).headers.authorization, 'Bearer gm_saved_synthetic');
  assert.equal((await run(['inboxes', 'list'], dir, { GROVE_MAIL_API_KEY: '' })).code, 2);
  assert.equal((await run(['auth', 'logout'], dir)).code, 0); assert.equal(existsSync(join(dir, 'config.json')), false);
});
test('watch resumes persisted cursor across split CRLF, reconnect and access revocation', async t => {
  const dir = isolated(t), cursor = join(dir, 'cursor'); writeFileSync(cursor, '5\n'); let count = 0;
  const server = await mock(t, (_, res) => {
    count++; if (count === 2) { reply(res, {}, 403); return; }
    res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write('id: 6\r');
    setTimeout(() => { res.write('\nevent: message.received\r\ndata: {"event_id":"synthetic"}\r'); setTimeout(() => res.end('\n\r\n'), 10); }, 10);
  });
  const result = await run(['messages', 'watch', '--inbox', 'a@example.com', '--cursor-file', cursor], dir, { GROVE_MAIL_BASE_URL: server.base });
  assert.equal(result.code, 1); assert.equal(JSON.parse(result.stdout).event_id, 'synthetic'); assert.equal(readFileSync(cursor, 'utf8'), '6\n'); assert.equal(statSync(cursor).mode & 0o777, 0o600);
  assert.equal(server.calls[0].headers['last-event-id'], '5'); assert.equal(server.calls[1].headers['last-event-id'], '6'); assert.ok(server.calls[1].url.endsWith('?after=6'));
});
test('descriptor downloads preserve bytes, never forward auth cross-origin, and reject redirects/expired grants', async t => {
  const dir = isolated(t), bytes = Buffer.from([0,255,13,10]);
  const external = await mock(t, (_, res) => { res.writeHead(200, { 'content-type': 'application/octet-stream' }); res.end(bytes); });
  let kind = 'external';
  const server = await mock(t, (req, res) => {
    if (req.url === '/download') { res.writeHead(200, { 'content-type': 'application/octet-stream' }); res.end(bytes); return; }
    if (req.url === '/redirect') { res.writeHead(302, { location: external.base + '/never' }); res.end(); return; }
    reply(res, { download_url: kind === 'external' ? external.base + '/file' : kind === 'unsafe' ? 'http://example.com/file' : kind === 'redirect' ? '/redirect' : '/download', expires_at: new Date(Date.now() + (kind === 'expired' ? -1000 : 60000)).toISOString() });
  });
  const args = ['inboxes','messages','get-attachment','--inbox-id','a@example.com','--message-id','m','--attachment-id','a','--output',join(dir,'saved')];
  assert.equal((await run(args,dir,{GROVE_MAIL_BASE_URL:server.base})).code,0); assert.deepEqual(readFileSync(join(dir,'saved')),bytes); assert.equal(external.calls[0].headers.authorization,undefined);
  kind = 'same'; assert.equal((await run(args,dir,{GROVE_MAIL_BASE_URL:server.base})).code,0); assert.equal(server.calls.at(-1).headers.authorization,'Bearer gm_synthetic_cli_test');
  for (kind of ['redirect','expired','unsafe']) assert.notEqual((await run(args,dir,{GROVE_MAIL_BASE_URL:server.base})).code,0);
  assert.equal(external.calls.length,1);
});
test('control-plane delete sends exact ID confirmation only after explicit confirmation', async t => {
  const dir=isolated(t), server=await mock(t,(_,res)=>{res.writeHead(204);res.end();});
  const env={GROVE_MAIL_BASE_URL:server.base};
  assert.equal((await run(['inboxes','delete','--inbox-id','a@example.com'],dir,env)).code,3);assert.equal(server.calls.length,0);
  assert.equal((await run(['inboxes','delete','--inbox-id','a@example.com','--confirmed'],dir,env)).code,0);assert.equal(server.calls[0].headers['x-confirm-delete'],'a@example.com');
  assert.equal((await run(['pods','domains','delete','--pod-id','pod-a','--domain-id','domain-a','--confirmed'],dir,env)).code,0);assert.equal(server.calls[1].headers['x-confirm-delete'],'domain-a');
});
