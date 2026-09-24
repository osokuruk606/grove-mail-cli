#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 Grove Mail contributors
// SPDX-License-Identifier: Apache-2.0
import { readFileSync, writeFileSync, mkdirSync, existsSync, chmodSync, renameSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname, basename } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fetch as undiciFetch } from 'undici';
import { schema } from './protocol.js';
import { cliOperations, specText, validate, type Shape } from './cli-contract.js';
import { formats, formatValue, project, validateQuery } from './cli-output.js';
import { CliError, fail, apiError, redact, resolveFileRefs, loadDotenv, dispatcher, retryDelay, humanError } from './cli-runtime.js';
import { commandSchema, helpText, completion, manPage, skillFiles, version, exitCodes } from './cli-discovery.js';

const fetch = undiciFetch as unknown as typeof globalThis.fetch;
process.umask(0o077);
const configPath = process.env.GROVE_MAIL_CLIENT_CONFIG ?? join(homedir(), '.config', 'grove-mail', 'config.json');
const options: Record<string, string[]> = Object.create(null), words: string[] = [];
const switches = new Set(['help', 'schema', 'spec', 'spec_raw', 'dry_run', 'confirmed', 'all', 'quiet', 'human', 'no_retry', 'no_extract', 'version', 'debug', 'with_token', 'no_browser']);
const scalar = (key: string) => options[key]?.[0];
const enabled = (key: string) => scalar(key) === 'true';
const norm = (key: string) => key.toLowerCase().replaceAll('-', '_');
let base = '', token: string | undefined, credentialSource: string | undefined, format = 'json';
let transport: ReturnType<typeof dispatcher> | undefined;
let retrySafe = false;
const timeout = () => { const value = Number(process.env.GROVE_MAIL_TIMEOUT_SECS ?? 120); if (!Number.isFinite(value) || value <= 0) fail('GROVE_MAIL_TIMEOUT_SECS must be positive.'); return value * 1000; };
const output = (value: unknown) => { if (!enabled('quiet')) process.stdout.write(formatValue(project(value, scalar('query')), format, enabled('all') ? { first: !pagePrinted } : undefined)); };
let stdin: string | undefined, pagePrinted = false;
function file(path: string) { if (path !== '-') return readFileSync(path, 'utf8'); if (stdin !== undefined) fail('stdin may only supply one input.'); return stdin = readFileSync(0, 'utf8'); }
function json(text: string, label: string): any { try { return JSON.parse(text); } catch { return fail(`${label} must be valid JSON.`); } }
function object(value: any, label: string) { if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be a JSON object.`); return value; }
function atomicWrite(path: string, data: string | Buffer) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${randomUUID()}.tmp`;
  try { writeFileSync(temp, data, { mode: 0o600, flag: 'wx' }); renameSync(temp, path); chmodSync(path, 0o600); }
  finally { if (existsSync(temp)) unlinkSync(temp); }
}
function parse() {
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    let arg = args[i];
    if (arg === '-h') arg = '--help'; if (arg === '-q') arg = '--quiet'; if (arg === '-V') arg = '--version';
    if (arg === '--') { words.push(...args.slice(i + 1)); break; }
    if (arg === '--json' && args.includes('auth') && args.includes('status')) { options.json = ['true']; continue; }
    if (!arg.startsWith('-')) { words.push(arg); continue; }
    if (!arg.startsWith('--')) fail(`Unknown option ${arg}.`);
    const index = arg.indexOf('='), key = norm(arg.slice(2, index < 0 ? undefined : index));
    let value = index < 0 ? undefined : arg.slice(index + 1);
    if (switches.has(key)) {
      value ??= ['true', 'false'].includes(args[i + 1]) ? args[++i] : 'true';
      if (!['true', 'false'].includes(value)) fail(`--${key.replaceAll('_', '-')} must be true or false.`);
    } else if (value === undefined) {
      value = args[++i];
      if (value === undefined || value.startsWith('--')) fail(`Missing value for --${key.replaceAll('_', '-')}.`);
    }
    (options[key] ??= []).push(value);
  }
}
function check(allowed: string[], repeatable: string[] = []) {
  const known = new Set(allowed), repeat = new Set(repeatable);
  for (const [key, values] of Object.entries(options)) {
    if (!known.has(key)) fail(`Unknown option --${key.replaceAll('_', '-')}.`);
    if (values.length > 1 && !repeat.has(key)) fail(`--${key.replaceAll('_', '-')} may only be specified once.`);
  }
}
function arrayShape(s: Shape = {}): Shape | undefined { return s.type === 'array' ? s : (s.anyOf ?? s.oneOf ?? []).find((v: Shape) => v.type === 'array'); }
function convert(values: string[], shape: Shape, name: string): any {
  const array = arrayShape(shape), branches = shape.anyOf ?? shape.oneOf ?? [];
  const scalarShape = branches.find((v: Shape) => !['array', 'null'].includes(v.type)) ?? shape;
  if (values.length === 1 && values[0] === 'null' && (shape.nullable || branches.some((v: Shape) => v.type === 'null'))) return null;
  if (array) {
    const result = values.flatMap(value => {
      if (value === 'null' && shape.nullable) return [];
      let decoded: any; try { decoded = JSON.parse(value); } catch { decoded = value; }
      if (Array.isArray(decoded)) return decoded;
      return [array.items?.type && array.items.type !== 'string' ? decoded : value];
    });
    if (!result.length && values.includes('null') && shape.nullable) return null;
    return shape.type !== 'array' && scalarShape.type === 'string' && result.length === 1 ? result[0] : result;
  }

  const value = values[0];
  if (scalarShape.type === 'boolean') { if (!['true', 'false', '1', '0'].includes(value)) fail(`${name} must be true or false.`); return value === 'true' || value === '1'; }
  if (['integer', 'number'].includes(scalarShape.type)) { if (!value.trim()) fail(`${name} must be numeric.`); return Number(value); }
  if (scalarShape.type === 'object') return resolveFileRefs(object(json(value, name), name));
  return value;
}

function safeBase(value: string) {
  let u: URL; try { u = new URL(value); } catch { return fail('Invalid base URL.'); }
  if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password || u.search || u.hash) fail('Base URL must be HTTP(S), with no credentials, query or fragment.');
  if (u.protocol !== 'https:' && !['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname)) fail('API keys require HTTPS outside localhost.');
  return u.toString().replace(/\/$/, '');
}
async function request(path: string, init: RequestInit = {}) {
  const publicSignup = init.method === 'POST' && path === '/v0/agent/sign-up';
  if (!token && !publicSignup) throw new CliError('Set GROVE_MAIL_API_KEY or run auth login --with-token.', 2, 'authError', 401);
  const method = init.method ?? 'GET', suffix = [scalar('user_agent_suffix'), process.env.GROVE_MAIL_USER_AGENT_SUFFIX].map(v => v?.trim()).find(v => v && /^[\x20-\x7e]+$/.test(v));
  const headers = { ...(token ? { Authorization: `Bearer ${token}` } : {}), 'User-Agent': `grove-mail/${version}${suffix ? ' ' + suffix : ''}`, ...Object.fromEntries(new Headers(init.headers)) };
  transport ??= dispatcher();
  for (let attempt = 0; ; attempt++) {
    if (enabled('debug')) process.stderr.write(JSON.stringify({ request: { method, url: base + path, headers: redact(headers, token), body: init.body ? '[omitted]' : undefined }, attempt: attempt + 1 }) + '\n');
    let response: Response;
    try {
      let destination = new URL(base + path), redirectedInit = { ...init }, requestHeaders: Record<string, string> = { ...headers };
      const signal = init.signal ?? AbortSignal.timeout(timeout());
      for (let hop = 0; ; hop++) {
        response = await fetch(destination, { ...redirectedInit, headers: requestHeaders, signal, redirect: 'manual', dispatcher: transport } as RequestInit);
        const location = response.headers.get('location');
        if (![301, 302, 303, 307, 308].includes(response.status) || !location) break;
        await response.body?.cancel();
        if (hop >= 9) fail('Too many HTTP redirects (limit 10).');
        const next = new URL(location, destination);
        if (!['http:', 'https:'].includes(next.protocol) || next.username || next.password) fail('Unsafe HTTP redirect target.');
        if (next.origin !== destination.origin) {
          if (!/^(1|true|yes)$/i.test(process.env.GROVE_MAIL_ALLOW_CROSS_HOST_REDIRECTS ?? '')) fail('Cross-origin HTTP redirect refused. Set GROVE_MAIL_ALLOW_CROSS_HOST_REDIRECTS=1 only for a trusted redirect.');
          requestHeaders = Object.fromEntries(Object.entries(requestHeaders).filter(([key]) => !['authorization', 'cookie'].includes(key.toLowerCase())));
        }
        if (response.status === 303 && redirectedInit.method !== 'HEAD' || [301, 302].includes(response.status) && redirectedInit.method === 'POST') {
          redirectedInit = { ...redirectedInit, method: 'GET', body: undefined };
          requestHeaders = Object.fromEntries(Object.entries(requestHeaders).filter(([key]) => !['content-type', 'content-length'].includes(key.toLowerCase())));
        }
        destination = next;
      }
    }
    catch (error) {
      if (error instanceof CliError || init.signal?.aborted) throw error;
      const delay = enabled('no_retry') || init.signal ? undefined : retryDelay(attempt, undefined, method, retrySafe);
      if (delay !== undefined) { await new Promise(resolve => setTimeout(resolve, delay)); continue; }
      throw new CliError('Network request failed. Check the address, connection and TLS settings.', 5, 'networkError');
    }
    if (enabled('debug')) process.stderr.write(JSON.stringify({ response: { status: response.status, headers: redact(Object.fromEntries(response.headers), token) } }) + '\n');
    const delay = enabled('no_retry') || init.signal ? undefined : retryDelay(attempt, response.status, method, retrySafe, response.headers.get('retry-after'));
    if (delay !== undefined) { await response.body?.cancel(); await new Promise(resolve => setTimeout(resolve, delay)); continue; }
    if (!response.ok && !['raw', 'http'].includes(format)) throw apiError(response.status, await response.text(), token, credentialSource);
    return response;
  }
}

async function download(descriptor: any): Promise<Buffer> {
  if (typeof descriptor?.download_url !== 'string') fail('Attachment/raw descriptor has no download_url.');
  const destination = new URL(descriptor.download_url, base + '/');
  if (!['http:', 'https:'].includes(destination.protocol) || destination.username || destination.password || destination.hash || (destination.protocol !== 'https:' && !['127.0.0.1', 'localhost', '[::1]'].includes(destination.hostname))) fail('Unsafe download URL.');
  if (descriptor.expires_at && Date.parse(descriptor.expires_at) <= Date.now()) throw new CliError('Download grant has expired; request a fresh descriptor.', 1, 'download_expired');
  // Signed external storage URLs must never receive the API credential.
  const headers: Record<string, string> = destination.origin === new URL(base).origin ? { Authorization: `Bearer ${token}` } : {};
  let response: Response;
  try { response = await fetch(destination, { headers, redirect: 'error', signal: AbortSignal.timeout(120_000) }); }
  catch { throw new CliError('Download failed; no redirect or retry was performed.', 1, 'download_failed'); }
  if (!response.ok) throw new CliError(`Download failed (HTTP ${response.status}); the grant may be expired or revoked.`, 1, 'download_failed', response.status);
  return Buffer.from(await response.arrayBuffer());
}
async function watch(inbox: string) {
  const cursorFile = scalar('cursor_file');
  let cursor = scalar('after') ?? (cursorFile && existsSync(cursorFile) ? readFileSync(cursorFile, 'utf8').trim() : undefined);
  if (cursor !== undefined && !/^\d+$/.test(cursor)) fail('Watch cursor must be a nonnegative sequence number.');
  const path = `/v0/inboxes/${encodeURIComponent(inbox)}/events/stream`;
  if (enabled('dry_run')) { output({ method: 'GET', url: base + path + (cursor !== undefined ? '?after=' + cursor : ''), headers: cursor !== undefined ? { 'Last-Event-ID': cursor } : {} }); return; }
  const control = new AbortController(); process.once('SIGINT', () => control.abort()); process.once('SIGTERM', () => control.abort());
  let delay = 1000;
  while (!control.signal.aborted) {
    try {
      const response = await request(path + (cursor !== undefined ? '?after=' + cursor : ''), { signal: control.signal, headers: { Accept: 'text/event-stream', ...(cursor !== undefined ? { 'Last-Event-ID': cursor } : {}) } });
      if (!response.headers.get('content-type')?.includes('text/event-stream')) throw new CliError('Expected an SSE event stream.', 1, 'invalid_stream', 400);
      const reader = response.body!.getReader(), decoder = new TextDecoder(); let buffer = '';
      try {
        while (!control.signal.aborted) {
          const chunk = await reader.read(); if (chunk.done) break;
          buffer += decoder.decode(chunk.value, { stream: true });
          if (buffer.length > 8 * 1024 * 1024) throw new CliError('Event exceeds the stream buffer limit.', 1, 'invalid_stream', 400);
          let boundary: RegExpExecArray | null;
          while ((boundary = /\r?\n\r?\n/.exec(buffer))) {
            const part = buffer.slice(0, boundary.index); buffer = buffer.slice(boundary.index + boundary[0].length);
            const lines = part.split(/\r?\n/), event = lines.find(l => l.startsWith('event:'))?.slice(6).trim();
            const data = lines.filter(l => l.startsWith('data:')).map(l => l.slice(5).replace(/^ /, '')).join('\n');
            if (event === 'error') throw new CliError('Stream access revoked.', 1, 'access_revoked', 401);
            if (data && event !== 'heartbeat') {
              let value: any; try { value = JSON.parse(data); } catch { throw new CliError('Malformed event JSON; cursor was not advanced.', 1, 'invalid_stream', 400); }
              let projected: unknown; try { projected = project({ type: event, ...value }, scalar('query')); } catch { throw new CliError('Watch --query evaluation failed; cursor was not advanced.', 3, 'validationError', 400); }
              if (projected !== null) await new Promise<void>((resolve, reject) => process.stdout.write(JSON.stringify(projected) + '\n', error => error ? reject(error) : resolve()));
            }
            const next = lines.find(l => l.startsWith('id:'))?.slice(3).trim();
            if (next !== undefined) {
              if (!/^\d+$/.test(next)) throw new CliError('Invalid event cursor.', 1, 'invalid_stream', 400);
              cursor = next; if (cursorFile) atomicWrite(cursorFile, cursor + '\n');
            }
            delay = 1000;
          }
        }
      } finally { await reader.cancel().catch(() => {}); }
    } catch (error: any) {
      if (control.signal.aborted) return;
      if ([400, 401, 403, 404].includes(error.status) || enabled('no_retry')) throw error;
      process.stderr.write(JSON.stringify({ event: 'reconnecting', after: cursor, delay_ms: delay }) + '\n');
    }
    if (enabled('no_retry')) return;
    if (!control.signal.aborted) await new Promise<void>(resolve => {
      const done = () => { clearTimeout(timer); control.signal.removeEventListener('abort', done); resolve(); };
      const timer = setTimeout(done, delay); control.signal.addEventListener('abort', done, { once: true });
    });
    delay = Math.min(delay * 2, 30_000);
  }
}
const globals = ['base_url', 'help', 'schema', 'spec', 'spec_raw', 'format', 'quiet', 'human', 'dry_run', 'no_retry', 'no_extract', 'version', 'debug', 'query', 'user_agent_suffix'];
async function main() {
  parse();
  if (words[0] === 'help') { words.shift(); options.help = ['true']; }
  const offline = enabled('help') || enabled('schema') || enabled('version') || enabled('spec') || enabled('spec_raw') || ['schema', 'spec', 'completion', 'man', 'errors', 'generate-skills'].includes(words[0]) || !words.length;
  if (!offline) loadDotenv();
  const rawEnvFormat = process.env.GROVE_MAIL_OUTPUT?.toLowerCase();
  const envFormat = rawEnvFormat === 'ndjson' ? 'jsonl' : rawEnvFormat === 'yml' ? 'yaml' : rawEnvFormat;
  format = scalar('format')?.toLowerCase() ?? (enabled('human') ? 'table' : envFormat && formats.includes(envFormat) ? envFormat : process.stdout.isTTY ? 'table' : 'json');
  format = ({ yml: 'yaml', ndjson: 'jsonl' } as Record<string, string>)[format] ?? format;
  if (!formats.includes(format)) fail(`Unknown format. Choose ${formats.join(', ')}.`);
  try { validateQuery(scalar('query')); } catch { fail('Invalid --query JMESPath expression.'); }
  let config: any = {};
  if (enabled('version')) { check(globals); process.stdout.write(`grove-mail ${version}\n`); return; }
  // Offline discovery never reads stored credentials.
  const discovery = offline;
  if (!discovery && !enabled('dry_run') && existsSync(configPath)) config = object(json(readFileSync(configPath, 'utf8'), 'config'), 'config');
  base = safeBase(scalar('base_url') ?? process.env.GROVE_MAIL_BASE_URL ?? config.base_url ?? 'https://mail.openmau.com/agent');
  token = process.env.GROVE_MAIL_API_KEY ?? config.api_key;
  credentialSource = process.env.GROVE_MAIL_API_KEY !== undefined ? 'GROVE_MAIL_API_KEY environment variable' : config.api_key ? 'Grove Mail credential file' : undefined;
  if (['schema', 'spec'].includes(words[0]) && words.length === 1) {
    check(globals); if (words[0] === 'spec') process.stdout.write(specText); else output({ ...schema(), cli_operations: cliOperations() }); return;
  }
  if (enabled('spec') || enabled('spec_raw')) { check(globals); process.stdout.write(specText); return; }
  const command = words.join(' ');
  if (words[0] === 'completion') { check(globals); if (enabled('help') || words.length === 1) process.stdout.write('Usage: grove-mail completion <bash|zsh|fish|powershell|elvish>\n'); else process.stdout.write(completion(words[1])); return; }
  if (command === 'man') { check(globals); process.stdout.write(enabled('help') ? 'Usage: grove-mail man > grove-mail.1\n' : manPage()); return; }
  if (command === 'errors') { check(globals); output({ exit_codes: exitCodes }); return; }
  if (command === 'generate-skills') { check([...globals, 'output_dir']); if (enabled('help')) { process.stdout.write('Usage: grove-mail generate-skills [--output-dir PATH]\n'); return; } const files = skillFiles(scalar('output_dir') ?? 'skills'); if (!enabled('dry_run')) for (const [path, text] of files) atomicWrite(path, text); output({ files: files.map(([path]) => path) }); return; }
  if (command === 'auth login' || command === 'auth status' || command === 'auth logout') {
    check([...globals, 'scheme', ...(command === 'auth login' ? ['key_file', 'with_token', 'no_browser'] : command === 'auth status' ? ['json'] : [])]);
    if (scalar('scheme') && scalar('scheme') !== 'BearerAuth') fail('Unknown auth scheme; choose BearerAuth.');
    if (enabled('help') || enabled('schema')) { if (enabled('schema')) output({ command, options: command === 'auth login' ? ['--with-token', '--key-file PATH', '--scheme BearerAuth', '--no-browser'] : ['--scheme BearerAuth'] }); else process.stdout.write(helpText(command)); return; }
    if (enabled('dry_run')) { output({ command, config_path: configPath, network: false }); return; }
    if (command === 'auth login') {
      const keyFile = scalar('key_file') ?? '-';
      if (scalar('key_file') && enabled('with_token')) fail('Use only one of --key-file and --with-token.');
      if (keyFile === '-' && process.stdin.isTTY) process.stderr.write('Paste your Grove Mail API key, then press Ctrl-D:\n');
      const api_key = file(keyFile).trim(); if (!api_key || /[\s\x00-\x1f\x7f]/.test(api_key)) fail('API key must be a nonempty token.');
      atomicWrite(configPath, JSON.stringify({ base_url: base, api_key }) + '\n'); output({ saved: configPath, base_url: base });
    } else if (command === 'auth logout') { if (existsSync(configPath)) unlinkSync(configPath); output({ logged_out: true }); }
    else {
      const env = process.env.GROVE_MAIL_API_KEY, stored = config.api_key;
      const sources = [{ source: 'GROVE_MAIL_API_KEY environment variable', state: env ? 'active' : 'missing' }, { source: 'Grove Mail credential file', state: stored ? env ? 'shadowed' : 'active' : 'missing' }];
      const value = { cli: 'grove-mail', backend: 'private file (0600)', schemes: [{ cli: 'grove-mail', scheme: 'BearerAuth', login_flow: null, logged_in: Boolean(env || stored), sources }] };
      if (enabled('json') || scalar('format') || !process.stdout.isTTY) output(value);
      else process.stderr.write(`grove-mail: credential status\n${sources.map(v => `  ${v.state}: ${v.source}`).join('\n')}\n`);
    }
    return;
  }
  if (['messages watch', 'events watch', 'inboxes messages watch', 'inboxes events watch'].includes(command)) {
    check([...globals, 'inbox', 'inbox_id', 'cursor_file', 'after']);
    if (enabled('help') || enabled('schema')) { if (enabled('schema')) output({ command, options: ['--inbox-id ADDRESS', '--cursor-file PATH', '--after SEQUENCE'], format: 'jsonl' }); else process.stdout.write(helpText(command)); return; }
    if (scalar('format') && !['json', 'jsonl'].includes(format)) fail('Watch supports jsonl output only.');
    if (enabled('quiet')) fail('Watch cannot be quiet because its cursor records emitted events.');
    if (scalar('inbox') && scalar('inbox_id')) fail('Use only one of --inbox and --inbox-id.');
    await watch(scalar('inbox_id') ?? scalar('inbox') ?? fail('Specify --inbox-id ADDRESS.')); return;
  }
  const catalog = cliOperations();
  let op = [...catalog].sort((a, b) => b.command.length - a.command.length).find(o => command === o.command || command.startsWith(o.command + ' '));
  // Preserve pre-existing scoped shorthand without changing official top-level requests.
  if (op && /^(webhooks|threads) /.test(op.command) && (scalar('inbox') || scalar('inbox_id'))) op = (schema().operations.find(o => o.command === op!.command) as any) ?? op;
  if (!op) {
    check(globals);
    const matching = catalog.filter(o => !command || o.command.startsWith(command + ' '));
    if (command && !matching.length) fail(`Unknown command: ${command}.`);
    if (command && !enabled('help') && !enabled('schema')) fail(`Choose an operation under ${command}; use --help.`);
    if (enabled('schema')) process.stdout.write(formatValue(commandSchema(command), 'json')); else process.stdout.write(helpText(command)); return;
  }
  const aliases: Record<string, string> = { inbox: 'inbox_id', message: 'message_id', attachment: 'attachment_id', thread: 'thread_id', webhook: 'webhook_id', key: 'api_key_id', pod: 'pod_id', draft: 'draft_id' };
  const pathKeys = [...op.path.matchAll(/:([a-z_]+)/g)].map(m => m[1]);
  const inputFields: Record<string, Shape> = commandSchema(op.command).input?.properties ?? {};
  const dotted = Object.fromEntries(Object.entries(inputFields).filter(([k, v]: [string, any]) => k.includes('.') && v.location === 'body'));
  const fields = { ...dotted, ...op.body?.properties, ...op.query?.properties, ...Object.fromEntries(Object.entries(op.headers?.properties ?? {}).map(([k, v]) => [norm(k), v])) };
  const bodyOptions = op.body ? ['body', 'json', 'body_file', 'params', ...('text' in (op.body.properties ?? {}) ? ['text_file'] : []), ...('html' in (op.body.properties ?? {}) ? ['html_file'] : []), ...('attachments' in (op.body.properties ?? {}) ? ['attach'] : [])] : ['params'];
  const applicableAliases = Object.keys(aliases).filter(k => pathKeys.includes(aliases[k]));
  const sending = ['POST', 'PUT', 'PATCH'].includes(op.method);
  check([...globals, ...bodyOptions, 'output', 'confirmed', ...(op.method === 'GET' && op.query?.properties?.page_token ? ['all', 'max_pages'] : []), ...(sending ? ['idempotency_key'] : []), ...pathKeys, ...applicableAliases, ...Object.keys(fields)], ['attach', ...Object.entries(fields).filter(([, v]) => arrayShape(v as Shape)).map(([k]) => k)]);
  const positional = words.slice(op.command.split(' ').length);
  if (enabled('help') || enabled('schema')) { if (positional.length) fail('Unexpected positional arguments.'); if (enabled('schema')) process.stdout.write(formatValue(commandSchema(op.command), 'json')); else process.stdout.write(helpText(op.command)); return; }
  for (const short of applicableAliases) if (scalar(short) !== undefined) {
    if (scalar(aliases[short]) !== undefined) fail(`Use only one of --${short} and --${aliases[short].replaceAll('_', '-')}.`);
    options[aliases[short]] = options[short];
  }
  const params = scalar('params') ? object(json(scalar('params')!, '--params'), '--params') : {};
  const allowedParams = new Set([...pathKeys, ...Object.keys(fields), ...Object.keys(op.headers?.properties ?? {})]);
  for (const key of Object.keys(params)) if (!allowedParams.has(key)) fail(`Unknown parameter ${key}.`);
  let position = 0; const pathValues: Record<string, string> = {};
  const path = op.path.replace(/:([a-z_]+)/g, (_, key) => {
    const value = params[key] ?? scalar(key) ?? positional[position++] ?? fail(`Required parameter '${key}' is missing. Provide it via --${key.replaceAll('_', '-')} or --params`);
    if (typeof value !== 'string' || !value.length) fail(`Invalid --${key.replaceAll('_', '-')}.`);
    try { validate(value, inputFields[key] ?? { type: 'string' }, key); } catch (error: any) { fail(error.message); }
    pathValues[key] = value; return encodeURIComponent(value);
  });
  if (position < positional.length) fail('Unexpected positional arguments.');
  const suppliedBodies = ['body', 'json', 'body_file'].filter(k => scalar(k) !== undefined);
  if (suppliedBodies.length > 1) fail('Use only one of --body, --json and --body-file.');
  const bodyInput = suppliedBodies.length ? scalar(suppliedBodies[0])! : undefined;
  let body: any = suppliedBodies.length ? resolveFileRefs(object(json(suppliedBodies[0] === 'body_file' ? file(bodyInput!) : bodyInput === '-' ? file('-') : bodyInput!.startsWith('@') ? file(bodyInput!.replace(/^@(file:\/\/)?/, '')) : bodyInput!, 'request body'), 'request body')) : {};
  if (suppliedBodies.includes('json') && [...Object.keys(op.body?.properties ?? {}), ...Object.keys(dotted)].some(k => options[k] || k in params)) fail('Cannot combine --json with per-field body flags. Use one or the other.');
  const query: Record<string, any> = {}, headers: Record<string, string> = {};
  for (const [kind, target] of [['body', body], ['query', query]] as const) {
    for (const [key, shape] of Object.entries(op[kind]?.properties ?? {}) as [string, Shape][]) {
      if (options[key]) target[key] = kind === 'query' && ['boolean', 'integer', 'number'].includes(shape.type) ? options[key][0] : convert(options[key], inputFields[key] ?? shape, '--' + key.replaceAll('_', '-'));
      if (key in params) {
        let value = params[key];
        if (kind === 'body' && typeof value === 'string') {
          const type = (inputFields[key] ?? shape).type;
          if (['boolean', 'integer', 'number'].includes(type)) value = convert([value], inputFields[key] ?? shape, key);
          else if (['object', 'array'].includes(type)) value = json(value, key);
        }
        target[key] = value;
      }
    }
  }
  for (const [key, shape] of Object.entries(dotted) as [string, Shape][]) {
    if (!options[key] && !(key in params)) continue;
    const parts = key.split('.'); if (options[parts[0]] || parts[0] in params || suppliedBodies.length) fail(`Cannot combine --${parts[0]} or --json with nested body flags.`);
    let target = body; for (const part of parts.slice(0, -1)) target = target[part] ??= {};
    target[parts.at(-1)!] = key in params ? params[key] : convert(options[key], inputFields[key] ?? shape, '--' + key.replaceAll('_', '-'));
  }
  for (const [key, shape] of Object.entries(op.headers?.properties ?? {}) as [string, Shape][]) {
    const k = norm(key), value = params[key] ?? params[k] ?? (options[k] ? convert(options[k], inputFields[key] ?? shape, '--' + k.replaceAll('_', '-')) : undefined);
    if (value !== undefined) headers[key] = String(value);
  }
  for (const key of ['text', 'html']) if (scalar(key + '_file')) {
    if (body[key] !== undefined) fail(`Use only one source for ${key}.`); body[key] = file(scalar(key + '_file')!);
  }
  if (options.attach) body.attachments = [...body.attachments ?? [], ...options.attach.map(path => ({ filename: basename(path), content: readFileSync(path).toString('base64') }))];
  try { if (op.body) validate(body, op.body, 'body'); if (op.query) {
    const forValidation = { ...query };
    for (const [key, value] of Object.entries(query)) {
      const shape = op.query.properties?.[key], input = inputFields[key] ?? shape;
      if (value === null && !input.nullable) fail(`query.${key} cannot be null.`);
      if (typeof value !== 'string' && !(shape?.type === 'boolean' && [0, 1].includes(value as number))) continue;
      if (shape?.type === 'boolean') {
        if (value === '') { delete forValidation[key]; continue; }
        if (!/^(true|false|1|0|yes|no|on|off|y|n|t|f)$/i.test(String(value))) fail(`query.${key} must be boolean.`);
        forValidation[key] = /^(true|1|yes|on|y|t)$/i.test(String(value));
      } else if (['integer', 'number'].includes(shape?.type)) {
        if (value === '') { delete forValidation[key]; continue; }
        if (shape.type === 'integer' && !/^[+-]?\d+$/.test(String(value))) fail(`query.${key} must be an integer.`);
        forValidation[key] = Number(value);
      } else if (shape?.type === 'array') forValidation[key] = [value];
    }
    validate(forValidation, op.query, 'query');
  } }
  catch (error: any) { fail(error.message); }
  const qs = new URLSearchParams();
  for (const [k, value] of Object.entries(query)) for (const item of Array.isArray(value) ? value : [value]) qs.append(k, item === null ? '' : String(item));
  const url = path + (qs.size ? '?' + qs : '');
  retrySafe = Boolean(op.idempotent || headers['Idempotency-Key'] || scalar('idempotency_key'));
  const key = sending ? headers['Idempotency-Key'] ?? scalar('idempotency_key') ?? randomUUID() : undefined;
  if (key) { if (!/^[A-Za-z0-9_.:-]{1,200}$/.test(key)) fail('Invalid idempotency key.'); headers['Idempotency-Key'] = key; }
  if (enabled('all') && (scalar('output') || ['raw', 'http'].includes(format))) fail('--all cannot combine with --output or raw/http format.');
  const maxPages = Number(scalar('max_pages') ?? 100);
  if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > 10000) fail('--max-pages must be between 1 and 10000.');
  const confirmedTarget = op.method === 'DELETE' ? /\/(?:inboxes|pods|domains)\/:([a-z_]+)$/.exec(op.path)?.[1] : undefined;
  if (confirmedTarget && enabled('confirmed')) headers['X-Confirm-Delete'] = pathValues[confirmedTarget];
  if (enabled('dry_run')) { output({ method: op.method, url: base + url, headers, ...(op.body ? { body } : {}), ...(key ? { idempotency_key: key } : {}) }); return; }
  if (op.method === 'DELETE' && !enabled('confirmed')) fail('This operation deletes or revokes data. Add --confirmed to perform it.');
  let nextUrl = url, pages = 0;
  const seen = new Set<string>(query.page_token ? [String(query.page_token)] : []);
  while (true) {
    const response = await request(nextUrl, { method: op.method, headers: { ...(op.body ? { 'Content-Type': 'application/json' } : {}), ...headers }, body: op.body && (Object.keys(body).length || suppliedBodies.length) ? JSON.stringify(body) : undefined });
    let data: Buffer = Buffer.from(await response.arrayBuffer());
    if (scalar('output')) {
      if (!response.ok) throw apiError(response.status, data.toString('utf8'), token, credentialSource);
      if (response.headers.get('content-type')?.includes('json') && /\/(raw|attachments\/[^/]+)$/.test(path)) data = await download(json(data.toString('utf8'), 'download descriptor'));
      if (scalar('output') === '-') process.stdout.write(data); else { atomicWrite(scalar('output')!, data); output({ saved: scalar('output'), bytes: data.length }); } return;
    }
    if (format === 'raw' || format === 'http') {
      if (!enabled('quiet')) { if (format === 'http') process.stdout.write(`HTTP/1.1 ${response.status} ${response.statusText}\r\n` + [...response.headers].map(([k, v]) => `${k}: ${v}`).join('\r\n') + '\r\n\r\n'); process.stdout.write(response.ok || !token || !data.includes(Buffer.from(token)) ? data : Buffer.from(data.toString('utf8').replaceAll(token, '[REDACTED]'))); } if (!response.ok) { process.stderr.write(`Error: HTTP ${response.status}\n`); process.exitCode = 1; } return;
    }
    if (data.length && !response.headers.get('content-type')?.includes('json')) fail('Binary/text response: use --output PATH (or -), or --format raw.');
    const value = data.length ? json(data.toString('utf8'), 'response') : null;
    output(value); pagePrinted = true;
    if (!enabled('all') || !value?.next_page_token) return;
    const next = String(value.next_page_token);
    if (seen.has(next)) throw new CliError('Server repeated a page token; pagination stopped.', 1, 'pagination_loop');
    if (++pages >= maxPages) throw new CliError('Maximum page count reached; results are incomplete.', 1, 'pagination_limit');
    seen.add(next); qs.set('page_token', next); nextUrl = path + '?' + qs;
  }
}
process.stdout.on('error', error => { if ((error as NodeJS.ErrnoException).code === 'EPIPE') process.exit(0); });
main().catch((error: any) => {
  const known = error instanceof CliError ? error : new CliError('CLI failed to read or process input. Check file paths, permissions and JSON.', 5, 'internalError');
  const value = redact(known.envelope(), token);
  // Watch stdout is an event log; never mix diagnostic envelopes into it.
  const streaming = words.at(-1) === 'watch' || enabled('all');
  if (streaming) process.stderr.write(formatValue(value, 'json'));
  else if (['table', 'csv', 'raw', 'http'].includes(format)) process.stderr.write(humanError(known, token));
  else process.stdout.write(formatValue(value, format === 'jsonl' ? 'jsonl' : 'json'));
  process.exitCode = known.exit;
}).finally(async () => { await transport?.close(); });
