// SPDX-FileCopyrightText: 2026 Grove Mail contributors
// SPDX-License-Identifier: Apache-2.0
import { readFileSync } from 'node:fs';

// Versioned public request schema, exported by the Grove Mail service.
// This client never imports mail storage, mailcow configuration or server code.
type Operation = { command: string; method: string; path: string; [key: string]: any };
const contract: { name: string; version: string; operations: Operation[] } = JSON.parse(readFileSync(new URL('../docs/reference/grove-mail-api.json', import.meta.url), 'utf8'));
export function schema() { return contract; }
