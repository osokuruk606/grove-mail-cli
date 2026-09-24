import { readFileSync } from 'node:fs';
import { schema } from './protocol.js';

// Keep the pinned source available to installed CLI symlinks as well as tsx.
export const specText = readFileSync(new URL('../docs/reference/agentmail-openapi-1.5.0.json', import.meta.url), 'utf8');
export const spec = JSON.parse(specText);
export type Shape = Record<string, any>;
export function dereference(value: any, seen: string[] = []): any {
  if (Array.isArray(value)) return value.map(v => dereference(v, seen));
  if (!value || typeof value !== 'object') return value;
  if (value.$ref) {
    if (seen.includes(value.$ref)) throw new Error(`Recursive schema: ${value.$ref}`);
    const target = value.$ref.split('/').slice(1).reduce((v: any, k: string) => v[k], spec);
    if (!target) throw new Error(`Unresolved schema: ${value.$ref}`);
    const { $ref, ...rest } = value;
    return { ...dereference(target, [...seen, $ref]), ...dereference(rest, seen) };
  }
  const resolved: Shape = Object.fromEntries(Object.entries(value).map(([k, v]) => [k, dereference(v, seen)]));
  if (resolved.allOf) {
    resolved.properties = Object.assign({}, ...resolved.allOf.map((v: Shape) => v.properties ?? {}), resolved.properties ?? {});
    resolved.required = [...new Set([...resolved.allOf.flatMap((v: Shape) => v.required ?? []), ...resolved.required ?? []])];
  }
  return resolved;
}
export const kebab = (s: string) => s.replace(/([a-z0-9])([A-Z])/g, '$1-$2').replaceAll('_', '-').toLowerCase();
export type CliOperation = {
  command: string; method: string; path: string; description: string; operationId?: string;
  idempotent?: boolean; body?: Shape; query?: Shape; headers?: Shape; pathParams?: string[]; source: string;
};
export const officialOperations: CliOperation[] = Object.entries(spec.paths).flatMap(([path, item]: [string, any]) =>
  Object.entries(item).filter(([, op]: any) => op.operationId).map(([method, raw]: [string, any]) => {
    const op = dereference(raw);
    const parameters = (where: string) => ({ type: 'object', properties: Object.fromEntries((op.parameters ?? []).filter((p: any) => p.in === where).map((p: any) => [p.name, p.schema])), required: (op.parameters ?? []).filter((p: any) => p.in === where && p.required).map((p: any) => p.name) });
    const groups = raw['x-fern-sdk-group-name'];
    const command = [...(Array.isArray(groups) ? groups : groups ? [groups] : raw.operationId.split('_').slice(0, -1)), raw['x-fern-sdk-method-name'] ?? raw.operationId.split('_').at(-1)].map(kebab).join(' ');
    return { operationId: op.operationId, idempotent: Boolean(raw['x-fern-idempotent']), command, method: method.toUpperCase(), path: path.replace(/\{([^}]+)\}/g, ':$1'), description: op.summary ?? '', source: 'official-contract; server support must be verified', body: op.requestBody?.content?.['application/json']?.schema, query: parameters('query'), headers: parameters('header'), pathParams: (op.parameters ?? []).filter((p: any) => p.in === 'path').map((p: any) => p.name) };
  }));
const local = schema().operations as any[];
export function cliOperations(): CliOperation[] {
  // Preserve existing short commands. Official spelling always uses the pinned contract.
  const all = officialOperations.map(op => ({ ...op }));
  for (const op of local) {
    const match = all.find(o => o.command === op.command);
    if (match && match.path === op.path && match.method === op.method) {
      for (const kind of ['body', 'query'] as const) if (op[kind]) {
        // A Grove extension must not turn an official path parameter into a second body input.
        const extensions = Object.fromEntries(Object.entries(op[kind].properties ?? {}).filter(([key]) => kind !== 'body' || !match.pathParams?.includes(key) || match.body?.properties?.[key]));
        match[kind] = { ...op[kind], ...match[kind], properties: { ...extensions, ...match[kind]?.properties }, required: match[kind]?.required ?? [] };
      }
      match.source = 'official-contract + Grove extensions; see coverage matrix';
    } else if (!match) all.push({ ...op, source: 'Grove contract' });
    else all.push({ ...op, command: `grove ${op.command}`, source: 'Grove contract' });
  }
  // Legacy webhook commands were inbox scoped; the official top-level scope is organization-wide.
  return all;
}
export function validate(value: any, shape: Shape = {}, name = 'value'): void {
  if (value === null && (shape.nullable || shape.type === 'null')) return;
  for (const sub of shape.allOf ?? []) validate(value, sub, name);
  if (shape.anyOf || shape.oneOf) {
    const matches = (shape.anyOf ?? shape.oneOf).filter((sub: Shape) => { try { validate(value, sub, name); return true; } catch { return false; } });
    if (!matches.length) throw new Error(`${name} does not match any allowed type.`);
  }
  if (shape.enum && !shape.enum.includes(value)) throw new Error(`${name} must be one of ${shape.enum.join(', ')}.`);
  const type = shape.type;
  if (type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${name} must be an object.`);
    for (const key of shape.required ?? []) if (value[key] === undefined) throw new Error(`${name}.${key} is required.`);
    for (const [key, item] of Object.entries(value)) {
      if (shape.properties?.[key]) validate(item, shape.properties[key], `${name}.${key}`);
      else if (shape.additionalProperties === false) throw new Error(`Unknown ${name}.${key}.`);
      else if (typeof shape.additionalProperties === 'object') validate(item, shape.additionalProperties, `${name}.${key}`);
    }
  } else if (type === 'array') {
    if (!Array.isArray(value)) throw new Error(`${name} must be an array.`);
    if (value.length < (shape.minItems ?? 0) || value.length > (shape.maxItems ?? Infinity)) throw new Error(`${name} has an invalid number of items.`);
    value.forEach((v, i) => validate(v, shape.items, `${name}[${i}]`));
  } else if (type === 'string') {
    if (typeof value !== 'string') throw new Error(`${name} must be a string.`);
    if (value.length < (shape.minLength ?? 0) || value.length > (shape.maxLength ?? Infinity) || (shape.pattern && !new RegExp(shape.pattern).test(value))) throw new Error(`${name} has an invalid value.`);
  } else if (type === 'boolean' && typeof value !== 'boolean') throw new Error(`${name} must be true or false.`);
  else if (['number', 'integer'].includes(type) && (typeof value !== 'number' || !Number.isFinite(value) || (type === 'integer' && !Number.isInteger(value)) || value < (shape.minimum ?? -Infinity) || value > (shape.maximum ?? Infinity))) throw new Error(`${name} must be a valid ${type}.`);
}
