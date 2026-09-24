// SPDX-FileCopyrightText: 2026 Grove Mail contributors
// SPDX-License-Identifier: Apache-2.0
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { cliOperations, type CliOperation } from './cli-contract.js';
import { fail } from './cli-runtime.js';
export const version: string = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
const pinned = JSON.parse(readFileSync(new URL('../docs/reference/agentmail-cli-discovery-1.5.0.json', import.meta.url), 'utf8'));
export const exitCodes = [
  ['success', 'Command completed successfully'], ['api', 'API returned a non-success HTTP status'], ['auth', 'Authentication failed or credentials missing'],
  ['validation', 'Invalid arguments or request body'], ['discovery', 'Schema loading or endpoint resolution failed'], ['other', 'Unexpected internal error']
].map(([category, description], code) => ({ category, code, description }));
const extras = ['auth login', 'auth logout', 'auth status', 'messages watch', 'events watch', 'inboxes messages watch', 'inboxes events watch', 'completion', 'man', 'generate-skills', 'errors', 'schema', 'spec'];
const globalFlags = [...pinned.root.globalFlags, { flag: '--human', description: 'Use table output even when piped' }, { flag: '--version', description: 'Print Grove Mail version' }];
const summary = (op: CliOperation) => ({ description: op.description, httpMethod: op.method, operation: op.command.replaceAll(' ', '.'), path: op.path.replace(/:([a-z_]+)/g, '{$1}') });
export function commandSchema(command = ''): any {
  if (pinned.operations[command]) return pinned.operations[command];
  const catalog = cliOperations(), op = catalog.find(v => v.command === command);
  if (op) return { ...summary(op), input: { type: 'object', properties: { ...Object.fromEntries((op.pathParams ?? [...op.path.matchAll(/:([a-z_]+)/g)].map(v => v[1])).map(k => [k, { type: 'string', location: 'path', flag: '--' + k.replaceAll('_', '-') }])), ...op.query?.properties, ...op.body?.properties } }, source: 'Grove extension' };
  const operations = pinned.root.operations.filter((v: any) => !command || v.operation.startsWith(command.replaceAll(' ', '.') + '.'));
  if (command) return operations.length ? operations : catalog.filter(v => v.command.startsWith(command + ' ')).map(summary);
  return { ...pinned.root, groveExtensions: { operations: catalog.filter(v => !pinned.operations[v.command]).map(summary), commands: extras, flags: ['--confirmed', '--all', '--max-pages', '--output', '--body-file', '--text-file', '--html-file', '--attach'], deletion: 'DELETE requires --confirmed. Inbox, pod and domain deletion additionally sends exact target confirmation.', credentialStorage: 'Grove config file, owner-only 0600; separate from AgentMail keyring.' } };
}
function flags(command: string): string[] {
  const op = cliOperations().find(v => v.command === command);
  const own = op ? Object.values(commandSchema(command).input?.properties ?? {}).map((v: any) => v.flag).filter(Boolean) as string[] : [];
  return [...new Set([...globalFlags.map((v: any) => v.flag), ...own, ...(op?.body ? ['--json', '--body-file', '--params'] : []), ...(op?.query?.properties?.page_token ? ['--all', '--max-pages'] : []), ...(op?.method === 'DELETE' ? ['--confirmed'] : []), ...(op && ['POST', 'PUT', 'PATCH'].includes(op.method) ? ['--idempotency-key'] : []), ...(command === 'auth login' ? ['--with-token', '--key-file', '--scheme', '--no-browser'] : command === 'auth status' ? ['--json'] : command === 'auth logout' ? ['--scheme'] : []), ...(command.endsWith(' watch') ? ['--inbox-id', '--inbox', '--cursor-file', '--after'] : []), ...(command === 'generate-skills' ? ['--output-dir'] : [])])];
}
export function helpText(command = ''): string {
  const op = cliOperations().find(v => v.command === command), children = [...new Set([...cliOperations().map(v => v.command), ...extras].filter(v => !command || v.startsWith(command + ' ')).map(v => v.slice(command ? command.length + 1 : 0).split(' ')[0]))].sort();
  let text = `${op?.description ?? (command ? `Grove Mail ${command}` : 'Grove Mail')}\n\nUsage: grove-mail${command ? ' ' + command : ''} [OPTIONS]${op || extras.includes(command) ? '' : ' <COMMAND>'}\n`;
  if (children.length) text += '\nCommands:\n' + children.map(v => `  ${v}`).join('\n') + '\n';
  const properties = op ? commandSchema(command).input?.properties ?? {} : {};
  text += '\nOptions:\n' + flags(command).map(flag => {
    const prop: any = Object.values(properties).find((v: any) => v.flag === flag);
    const global = globalFlags.find((v: any) => v.flag === flag);
    const value = prop ? ` <${prop.type === 'array' ? 'VALUE (repeatable)' : prop.type?.toUpperCase() ?? 'VALUE'}>` : global?.valueName ? ` <${global.valueName}>` : (flag === '--json' && command !== 'auth status' || ['--body-file', '--key-file', '--scheme', '--output-dir', '--max-pages', '--inbox-id', '--inbox', '--cursor-file', '--after'].includes(flag)) ? ' <VALUE>' : '';
    return `  ${flag}${value}\n      ${prop?.description || global?.description || 'Grove extension'}`;
  }).join('\n') + '\n';
  if (!command) text += '\nAuthentication: GROVE_MAIL_API_KEY or auth login --with-token. Credentials are stored in a private file.\nEnvironment: GROVE_MAIL_BASE_URL, GROVE_MAIL_OUTPUT, GROVE_MAIL_TIMEOUT_SECS, GROVE_MAIL_PROXY, GROVE_MAIL_CA_BUNDLE, GROVE_MAIL_INSECURE, GROVE_MAIL_USER_AGENT_SUFFIX.\nGrove additions: SSE watch, bounded --all pagination, direct --output downloads and explicit --confirmed deletion.\nUse --schema for the pinned 140-operation contract and Grove extensions.\n';
  return text;
}
function choices() {
  const commands = [...cliOperations().map(v => v.command), ...extras], scopes = new Set(['']);
  for (const command of commands) for (let n = 1; n <= command.split(' ').length; n++) scopes.add(command.split(' ').slice(0, n).join(' '));
  return [...scopes].map(scope => [scope, [...new Set([...commands.filter(c => c.startsWith(scope ? scope + ' ' : '')).map(c => c.slice(scope ? scope.length + 1 : 0).split(' ')[0]), ...flags(scope)])].join(' ')] as const);
}
export function completion(shell: string): string {
  const scopes = choices(), all = [...new Set(scopes.flatMap(([, v]) => v.split(' ')))].filter(Boolean), quote = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'";
  const cases = scopes.map(([scope, values]) => `    ${quote(scope)}) candidates=${quote(values)} ;;`).join('\n');
  if (shell === 'bash' || shell === 'zsh') {
    const zsh = shell === 'zsh';
    return `${zsh ? '#compdef grove-mail\n' : ''}_grove_mail() {\n  local scope='' word candidates=''\n  local i\n  for ((i=${zsh ? 2 : 1}; i<${zsh ? 'CURRENT' : 'COMP_CWORD'}; i++)); do\n    word=\"\${${zsh ? 'words' : 'COMP_WORDS'}[i]}\"\n    case \"$word\" in --*) break ;; esac\n    scope=\"\${scope:+$scope }$word\"\n  done\n  case \"$scope\" in\n${cases}\n  esac\n  ${zsh ? 'compadd -- ${(z)candidates}\n  _files' : 'COMPREPLY=( $(compgen -W "$candidates" -- "${COMP_WORDS[COMP_CWORD]}") )\n  if [[ ${#COMPREPLY[@]} -eq 0 ]]; then COMPREPLY=( $(compgen -f -- "${COMP_WORDS[COMP_CWORD]}") ); fi'}\n}\n${zsh ? 'compdef _grove_mail grove-mail' : 'complete -F _grove_mail grove-mail'}\n`;
  }
  if (shell === 'fish') return all.map(v => v.startsWith('--') ? `complete -c grove-mail -l ${quote(v.slice(2))}` : `complete -c grove-mail -a ${quote(v)}`).join('\n') + '\n';
  if (shell === 'powershell') return `Register-ArgumentCompleter -Native -CommandName grove-mail -ScriptBlock {\n param($wordToComplete, $commandAst, $cursorPosition)\n @(${all.map(quote).join(',')}) | Where-Object { $_ -like "$wordToComplete*" } | ForEach-Object { [System.Management.Automation.CompletionResult]::new($_, $_, 'ParameterValue', $_) }\n}\n`;
  if (shell === 'elvish') return `set edit:completion:arg-completer[grove-mail] = {|@words|\n put ${all.map(quote).join(' ')}\n}\n`;
  return fail('Unknown completion shell; choose bash, zsh, fish, powershell or elvish.');
}
export function manPage() { return `.TH GROVE-MAIL 1\n.SH NAME\ngrove-mail \\- email for agents\n.SH SYNOPSIS\n.B grove-mail\nresource [subresource] operation [options]\n.SH DESCRIPTION\n${helpText().replaceAll('\\', '\\e').replaceAll('\n.', '\n\\&.')}\n.SH OPERATIONS\n${cliOperations().map(o => `.TP\n.B ${o.command}\n${o.description}`).join('\n')}\n`; }
export function skillFiles(directory: string): [string, string][] {
  const catalog = cliOperations(), groups = [...new Set(catalog.map(o => o.command.split(' ')[0]))].sort();
  return [['shared', 'Use grove-mail to manage mail. Use --schema for machine-readable discovery, --help for commands and --dry-run before requests. Configure GROVE_MAIL_API_KEY or auth login --with-token. DELETE requires --confirmed. Prefer --json for bodies and --params for parameter objects. Use --query for JMESPath projections. Errors have numeric HTTP code, message and reason; run errors for exit codes.'], ...groups.map(group => [group, catalog.filter(o => o.command.split(' ')[0] === group).map(o => `- \`grove-mail ${o.command}\`: ${o.description}. Use \`--schema\` for parameters and response fields.`).join('\n')])].map(([group, body]) => [join(directory, `grove-mail-${group}`, 'SKILL.md'), `---\nname: grove-mail-${group}\ndescription: Grove Mail ${group} CLI operations\n---\n\n# Grove Mail ${group}\n\n${body}\n`]);
}
