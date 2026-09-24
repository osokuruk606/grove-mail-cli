// SPDX-FileCopyrightText: 2026 Grove Mail contributors
// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { cwd, isolated, mock, reply, run } from './cli-helpers.js';
const executable = process.env.AGENTMAIL_CLI ?? '';
const cases = [
  { command: ['inboxes','messages','list'], flags: ['--inbox-id','one@example.com','--labels','one','--labels','two','--ascending','false'], path: '/v0/inboxes/one%40example.com/messages', method: 'GET', response: {messages:[],count:0} },
  { command: ['inboxes','messages','send'], flags: ['--inbox-id','one@example.com','--to','one@example.com','--to','two@example.com','--text','synthetic body','--idempotency-key','test-key'], path:'/v0/inboxes/one%40example.com/messages/send', method:'POST', response: {message_id:'synthetic-m',thread_id:'synthetic-t'} },
  { command: ['inboxes','messages','get-attachment'], flags:['--inbox-id','one@example.com','--message-id','m/a','--attachment-id','a+1'], path:'/v0/inboxes/one%40example.com/messages/m%2Fa/attachments/a%2B1', method:'GET', response:{attachment_id:'a+1',download_url:'https://example.invalid/synthetic'} },
  { command: ['inboxes','messages','get-raw'], flags:['--inbox-id','one@example.com','--message-id','m'], path:'/v0/inboxes/one%40example.com/messages/m/raw', method:'GET', response:{download_url:'https://example.invalid/synthetic.eml'} },
  { command: ['inboxes','messages','reply-all'], flags:['--inbox-id','one@example.com','--message-id','m','--text','synthetic reply','--idempotency-key','reply-key'], path:'/v0/inboxes/one%40example.com/messages/m/reply-all', method:'POST', response:{message_id:'synthetic-r',thread_id:'synthetic-t'} },
  { command: ['inboxes','drafts','create'], flags:['--inbox-id','one@example.com','--to','one@example.com','--text','synthetic draft'], path:'/v0/inboxes/one%40example.com/drafts', method:'POST', response:{draft_id:'synthetic-d'} },
  { command: ['pods','inboxes','list'], flags:['--pod-id','test-pod','--limit','2','--ascending','true'], path:'/v0/pods/test-pod/inboxes', method:'GET', response:{inboxes:[],count:0} },
  { command: ['api-keys','create'], flags:['--name','synthetic key','--permissions','{"message_read":true}'], path:'/v0/api-keys', method:'POST', response:{api_key_id:'synthetic-k'} },
  { command: ['webhooks','create'], flags:['--url','https://example.invalid/hook','--event-types','message.received','--event-types','message.sent'], path:'/v0/webhooks', method:'POST', response:{webhook_id:'synthetic-h'} },
];
test('unchanged AgentMail CLI 1.5.0 and Grove CLI send equivalent captured local requests', {skip: !existsSync(executable) ? 'blocked-external: set AGENTMAIL_CLI to unmodified 1.5.0 executable' : false}, async t => {
  const dir = isolated(t);
  for (const c of cases) await t.test(c.command.join(' '), async t => {
    const server = await mock(t, (_, res) => reply(res, c.response));
    for (const binary of [executable, undefined]) {
      const result = await run([...c.command, ...c.flags, '--base-url', server.base, '--format','json','--no-retry','--no-extract'], dir, {}, '', binary);
      assert.equal(result.code, 0, result.stderr); assert.deepEqual(JSON.parse(result.stdout), c.response);
    }
    assert.equal(server.calls.length, 2); const [official, grove] = server.calls;
    for (const call of server.calls) { const url = new URL(call.url, server.base); assert.equal(url.pathname, c.path); assert.equal(call.method, c.method); assert.match(call.headers.authorization, /^Bearer /); }
    assert.deepEqual([...new URL(official.url,server.base).searchParams].sort(), [...new URL(grove.url,server.base).searchParams].sort());
    assert.deepEqual(grove.body, official.body);
    if (c.flags.includes('--idempotency-key') || c.method !== 'POST') assert.equal(grove.headers['idempotency-key'], official.headers['idempotency-key']);
    else for (const call of server.calls) assert.match(call.headers['idempotency-key'], /^[a-f0-9-]{36}$/);
    if (c.method === 'POST') assert.match(grove.headers['content-type'], /application\/json/);
  });
});
