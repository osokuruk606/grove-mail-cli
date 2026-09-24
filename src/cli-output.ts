import jmespath from 'jmespath';
import { stringify } from 'yaml';
export const formats = ['json', 'jsonl', 'raw', 'http', 'table', 'csv', 'yaml'];
export const sorted = (value: any): any => Array.isArray(value) ? value.map(sorted) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(k => [k, sorted(value[k])])) : value;
export function validateQuery(query?: string) { if (query !== undefined) (jmespath as typeof jmespath & { compile(expression: string): unknown }).compile(query); }
export function project(value: any, query?: string) { return query === undefined ? value : jmespath.search(value, query); }
function items(value: any): any[] | undefined {
  if (Array.isArray(value)) return value;
  if (value && typeof value === 'object') for (const key of Object.keys(value).sort()) {
    if (key !== 'nextPageToken' && key !== 'kind' && !key.startsWith('_') && Array.isArray(value[key]) && value[key].length) return value[key];
  }
}
const cell = (value: any): string => value == null ? '' : typeof value === 'string' ? value : Array.isArray(value) ? value.map(cell).join(', ') : typeof value === 'object' ? JSON.stringify(sorted(value)) : String(value);
const terminal = (value: string) => value.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, ' ');
function flat(value: any, prefix = ''): [string, string][] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [[prefix, terminal(cell(value))]];
  return Object.keys(value).sort().flatMap(k => flat(value[k], prefix ? `${prefix}.${k}` : k));
}
export function formatValue(value: any, format: string, page?: { first: boolean }): string {
  value = sorted(value);
  if (format === 'jsonl') return (items(value) ?? [value]).map(v => JSON.stringify(v)).join('\n') + '\n';
  if (format === 'yaml') return (page ? '---\n' : '') + stringify(value, { defaultStringType: 'QUOTE_DOUBLE', defaultKeyType: 'PLAIN', lineWidth: 0 });
  if (format === 'csv') {
    const rows = items(value); if (!rows) return cell(value) + '\n';
    const escape = (s: string) => /[,"\r\n]/.test(s) ? '"' + s.replaceAll('"', '""') + '"' : s;
    if (!rows.length) return '\n';
    if (!rows.some(v => v && typeof v === 'object' && !Array.isArray(v))) return rows.map(v => (Array.isArray(v) ? v : [v]).map(v => escape(cell(v))).join(',')).join('\n') + '\n\n';
    const columns = [...new Set(rows.flatMap(v => v && typeof v === 'object' && !Array.isArray(v) ? Object.keys(v) : []))];
    return [...(!page || page.first ? [columns.map(escape).join(',')] : []), ...rows.map(row => columns.map(k => escape(cell(row?.[k]))).join(','))].join('\n') + '\n\n';
  }
  if (format === 'table') {
    const rows = items(value);
    if (!rows) {
      if (!value || typeof value !== 'object') return JSON.stringify(value) + '\n';
      const fields = flat(value), width = Math.max(0, ...fields.map(([k]) => [...k].length));
      return fields.map(([k, v]) => k + ' '.repeat(width - [...k].length + 2) + v).join('\n') + '\n\n';
    }
    if (!rows.length) return '(empty)\n\n';
    const maps = rows.map(v => new Map(flat(v))), columns = [...new Set(maps.flatMap(v => [...v.keys()]))];
    const widths = columns.map(k => Math.min(60, Math.max([...k].length, ...maps.map(v => [...(v.get(k) ?? '')].length))));
    const render = (row: string[], truncate = true) => row.map((s, i) => { const chars = [...s]; const text = truncate && chars.length > widths[i] ? chars.slice(0, widths[i] - 1).join('') + '…' : s; return text + ' '.repeat(Math.max(0, widths[i] - [...text].length)); }).join('  ');
    return [...(!page || page.first ? [render(columns, false), widths.map(w => '─'.repeat(w)).join('  ')] : []), ...maps.map(row => render(columns.map(k => row.get(k) ?? '')))].join('\n') + '\n\n';
  }
  return JSON.stringify(value, null, format === 'json' && !page ? 2 : undefined) + '\n';
}
