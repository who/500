/**
 * Serializing {@link GameRecord}s to a JSONL corpus. Each record is one line;
 * appends are the primary mode so a long-running server never rewrites the
 * file. The parent directory is created on demand.
 */

import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { GameRecord } from './schema.js';

/** One JSONL line (no trailing newline). */
export function serializeGameRecord(record: GameRecord): string {
  return JSON.stringify(record);
}

/** Append one record as a line, creating the parent directory if needed. */
export function appendGameRecordSync(path: string, record: GameRecord): void {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, serializeGameRecord(record) + '\n');
}

/** Write a whole corpus at once, replacing any existing file. */
export function writeGameRecordsSync(path: string, records: readonly GameRecord[]): void {
  mkdirSync(dirname(path), { recursive: true });
  const body = records.map(serializeGameRecord).join('\n');
  writeFileSync(path, body.length > 0 ? body + '\n' : '');
}
