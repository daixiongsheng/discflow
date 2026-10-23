import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

export function dataRoot(): string {
  return resolve(process.env.DATA_DIR ?? join(process.cwd(), 'data'));
}

export function jobsRoot(): string {
  return join(dataRoot(), 'jobs');
}

export function incomingRoot(): string {
  return join(dataRoot(), 'incoming');
}

export function ensureStorageDirectories(): void {
  mkdirSync(jobsRoot(), { recursive: true });
  mkdirSync(incomingRoot(), { recursive: true });
}

