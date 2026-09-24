import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parse as parseDotenv } from 'dotenv';
import { rootCertificates } from 'node:tls';
import { Agent, EnvHttpProxyAgent, type Dispatcher } from 'undici';

export class CliError extends Error {
  details?: unknown; help?: string;
  constructor(message: string, public exit = 3, public reason = 'validationError', public status?: number) { super(message); }
  envelope() { return { error: { ...(this.status !== undefined ? { code: this.status } : this.exit === 3 ? { code: 400 } : this.exit === 2 ? { code: 401 } : this.exit === 5 && this.reason !== 'networkError' ? { code: 500 } : {}), message: this.message, reason: this.reason, ...(this.details === undefined ? {} : { details: this.details }), ...(this.help ? { help: this.help } : {}) } }; }
}
export const fail = (message: string): never => { throw new CliError(message); };
export function redact(value: any, token?: string): any {
  if (typeof value === 'string') return (token ? value.replaceAll(token, '[REDACTED]') : value).replace(/\b(?:gm_|sk_live_|sk_test_)[A-Za-z0-9_-]+/g, '[REDACTED]').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, '');
  if (Array.isArray(value)) return value.map(v => redact(v, token));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, /^(authorization|cookie|set-cookie|api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret)$/i.test(k) ? '[REDACTED]' : redact(v, token)]));
  return value;
}
const reasons: Record<number, string> = { 400: 'badRequest', 401: 'unauthorized', 403: 'forbidden', 404: 'notFound', 405: 'methodNotAllowed', 408: 'requestTimeout', 409: 'conflict', 422: 'unprocessableEntity', 429: 'tooManyRequests', 500: 'internalServerError', 502: 'badGateway', 503: 'serviceUnavailable', 504: 'gatewayTimeout' };
export function apiError(status: number, text: string, token?: string, source?: string) {
  let body: any; try { body = redact(JSON.parse(text), token); } catch { body = redact(text, token).trim(); }
  let reason = reasons[status] ?? 'apiError', message = `HTTP ${status} ${reason}`;
  const sentence = (v: any): string | undefined => typeof v === 'string' && v.trim() ? v.replace(/\s+/g, ' ').trim() : undefined;
  let found: { parent: any; key: string | number } | undefined;
  const visit = (v: any): void => {
    if (!v || typeof v !== 'object' || found) return;
    for (const k of ['message', 'msg', 'error_description', 'detail', 'error']) if (sentence(v[k])) { message = sentence(v[k])!; found = { parent: v, key: k }; break; }
    if (!found) for (const k of ['error', 'detail', 'errors']) if (v[k] && typeof v[k] === 'object') visit(v[k]);
    if (!found && Array.isArray(v)) for (const item of v) { visit(item); if (found) break; }
  };
  if (typeof body === 'string') {
    const single = sentence(body);
    if (single && !/^\s*</.test(body) && single.length <= 512) { message = single; body = undefined; }
    else if (single) body = { body: single.slice(0, 512) + (single.length > 512 ? '…' : '') }; else body = undefined;
  } else {
    const inner = body?.error && typeof body.error === 'object' ? body.error : body?.detail && typeof body.detail === 'object' && !Array.isArray(body.detail) ? body.detail : body;
    for (const k of ['reason', 'code', 'status', 'type']) if (typeof inner?.[k] === 'string' && inner[k]) { reason = inner[k]; break; }
    visit(body);
    if (found) delete found.parent[found.key];
    const prune = (v: any): any => Array.isArray(v) ? v.map(prune) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, prune(x)]).filter(([, x]) => !(x && typeof x === 'object' && !Array.isArray(x) && !Object.keys(x).length))) : v;
    body = prune(body); if (body && !Array.isArray(body) && !Object.keys(body).length) body = undefined;
  }
  const error = new CliError(message, 1, reason, status); error.details = body;
  if ([401, 403].includes(status) && source) error.help = `Credentials were supplied via: ${source}.`;
  return error;
}
export function resolveFileRefs(value: any): any {
  if (Array.isArray(value)) return value.map(resolveFileRefs);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, resolveFileRefs(v)]));
  if (typeof value !== 'string') return value;
  if (value.startsWith('\\@')) return value.slice(1);
  if (!value.startsWith('@')) return value;
  const mode = value.startsWith('@file://') ? 'text' : value.startsWith('@data://') ? 'data' : 'auto';
  const path = value.slice(mode === 'auto' ? 1 : 8);
  if (/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/.test(path)) fail('File reference contains unsafe characters.');
  let bytes: Buffer; try { bytes = readFileSync(path); } catch { return fail('Unable to read JSON file reference. Check its path and permissions.'); }
  if (mode === 'data') return bytes.toString('base64');
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { if (mode === 'text') fail('JSON @file:// reference must contain UTF-8 text; use @data:// for binary.'); return bytes.toString('base64'); }
}
export function loadDotenv() {
  let dir = process.cwd();
  while (true) {
    const path = join(dir, '.env');
    if (existsSync(path)) {
      let values: Record<string, string>; try { values = parseDotenv(readFileSync(path)); } catch { return; }
      const ignored: string[] = [];
      for (const [key, value] of Object.entries(values)) {
        if (!/^GROVE_MAIL_/.test(key)) continue;
        if (/_(BASE_URL|CLIENT_CONFIG|PAGER|PROXY|NO_PROXY|INSECURE|INSECURE_SKIP_VERIFY|CA_BUNDLE|EXTRA_CA_CERTS|ALLOW_CROSS_HOST_REDIRECTS|ALLOW_CROSS_HOST_PAGINATION)$/.test(key)) { ignored.push(key); continue; }
        if (process.env[key] === undefined) process.env[key] = value;
      }
      if (ignored.length) process.stderr.write(`Ignored transport/execution settings in .env: ${ignored.join(', ')}\n`);
      return;
    }
    const parent = dirname(dir); if (parent === dir) return; dir = parent;
  }
}
export function dispatcher(): Dispatcher {
  const caFile = process.env.GROVE_MAIL_CA_BUNDLE ?? process.env.GROVE_MAIL_EXTRA_CA_CERTS ?? process.env.SSL_CERT_FILE;
  const insecure = [process.env.GROVE_MAIL_INSECURE, process.env.GROVE_MAIL_INSECURE_SKIP_VERIFY].some(v => /^(1|true|yes)$/i.test(v ?? ''));
  if (insecure) process.stderr.write('Warning: TLS certificate verification disabled by GROVE_MAIL_INSECURE.\n');
  const connect: any = { rejectUnauthorized: !insecure };
  if (process.env.GROVE_MAIL_CONNECT_TIMEOUT_SECS) { const seconds = Number(process.env.GROVE_MAIL_CONNECT_TIMEOUT_SECS); if (!Number.isFinite(seconds) || seconds <= 0) fail('GROVE_MAIL_CONNECT_TIMEOUT_SECS must be positive.'); connect.timeout = seconds * 1000; }
  if (caFile) { try { connect.ca = [...rootCertificates, readFileSync(caFile, 'utf8')]; } catch { fail('Unable to read the configured CA bundle.'); } }
  const proxy = process.env.GROVE_MAIL_PROXY;
  if (proxy || process.env.HTTP_PROXY || process.env.HTTPS_PROXY || process.env.http_proxy || process.env.https_proxy) return new EnvHttpProxyAgent({ httpProxy: proxy, httpsProxy: proxy, noProxy: process.env.GROVE_MAIL_NO_PROXY ?? process.env.NO_PROXY ?? process.env.no_proxy, connect, requestTls: connect });
  return new Agent({ connect });
}
export function retryDelay(attempt: number, status: number | undefined, method: string, idempotent: boolean, retryAfter?: string | null): number | undefined {
  if (attempt >= 3 || (status !== undefined && status !== 408 && status !== 429 && (status < 500 || status > 599))) return;
  if (![408, 429].includes(status ?? 0) && !idempotent && !['GET', 'HEAD', 'OPTIONS', 'DELETE', 'PUT'].includes(method)) return;
  if (retryAfter) { const seconds = /^\d+$/.test(retryAfter) ? Number(retryAfter) : undefined; const ms = seconds === undefined ? Date.parse(retryAfter) - Date.now() : seconds * 1000; if (Number.isFinite(ms)) return Math.max(0, ms); }
  return Math.round(500 * 2 ** attempt * (0.9 + Math.random() * 0.2));
}
export function humanError(error: CliError, token?: string): string {
  const v = redact(error.envelope(), token).error;
  const category = error.exit === 1 ? 'api' : error.exit === 2 ? 'auth' : error.exit === 3 ? 'validation' : error.exit === 4 ? 'discovery' : error.reason === 'networkError' ? 'network' : 'internal';
  let text = `error[${category}]: ${v.message}${error.exit === 1 && v.reason !== reasons[error.status ?? 0] ? ` (${v.reason})` : ''}\n`;
  let details = v.details;
  if (details && typeof details === 'object' && !Array.isArray(details) && Object.keys(details).length === 1 && ['error', 'detail'].includes(Object.keys(details)[0])) details = Object.values(details)[0];
  const lines: string[] = [];
  const visit = (value: any, path: string) => {
    if (value && typeof value === 'object' && !Array.isArray(value)) for (const key of Object.keys(value).sort()) visit(value[key], path ? `${path}.${key}` : key);
    else if (Array.isArray(value) && value.some(v => v && typeof v === 'object')) value.forEach((v, i) => visit(v, `${path}[${i}]`));
    else if (value !== v.message && value !== v.reason) lines.push(`  ${path}: ${Array.isArray(value) ? value.join(', ') : value}`);
  };
  if (details !== undefined) visit(details, '');
  text += lines.slice(0, 10).join('\n') + (lines.length ? '\n' : '');
  if (lines.length > 10) text += `  … ${lines.length - 10} more; use --format json\n`;
  if (v.help) text += `  ${v.help}\n`;
  return text;
}
