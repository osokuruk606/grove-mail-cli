import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
export const cwd = fileURLToPath(new URL('..', import.meta.url));
export function isolated(t: any) { const dir = mkdtempSync(join(tmpdir(), 'gm-cli-')); t.after(() => rmSync(dir, { recursive: true, force: true })); return dir; }
export async function mock(t: any, handler: (req: IncomingMessage, res: ServerResponse, body: any) => any) {
  const calls: any[] = [];
  const server = createServer(async (req, res) => { let body = ''; for await (const chunk of req) body += chunk; const value = body ? JSON.parse(body) : undefined; calls.push({ method: req.method, url: req.url, headers: req.headers, body: value }); await handler(req, res, value); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  return { calls, base: `http://127.0.0.1:${(server.address() as any).port}`, server };
}
export function reply(res: ServerResponse, body: any, status = 200) { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); }
export function launch(args: string[], dir: string, extra: Record<string, string | undefined> = {}, executable?: string) {
  const child = spawn(executable ?? process.execPath, executable ? args : ['--import', join(cwd, 'node_modules/tsx/dist/loader.mjs'), join(cwd, 'src/cli.ts'), ...args], { cwd: dir, env: { PATH: process.env.PATH, HOME: dir, TMPDIR: process.env.TMPDIR, XDG_CONFIG_HOME: dir, GROVE_MAIL_CLIENT_CONFIG: join(dir, 'config.json'), GROVE_MAIL_API_KEY: 'gm_synthetic_cli_test', AGENTMAIL_API_KEY: 'synthetic_official_test', AGENTMAIL_TIMEOUT_SECS: '5', NO_PROXY: '*', ...extra }, stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '', stderr = ''; child.stdout.on('data', data => stdout += data); child.stderr.on('data', data => stderr += data);
  const result = new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => { const timeout = setTimeout(() => { child.kill('SIGKILL'); reject(Error('CLI process timeout')); }, 15000); child.once('error', reject); child.once('close', code => { clearTimeout(timeout); resolve({ code, stdout, stderr }); }); });
  return { child, result };
}
export async function run(args: string[], dir: string, extra: Record<string, string | undefined> = {}, input = '', executable?: string) { const process = launch(args, dir, extra, executable); process.child.stdin.end(input); return process.result; }
