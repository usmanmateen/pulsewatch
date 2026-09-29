/**
 * Small helpers shared by the local CLI scripts (Node.js, not the Worker).
 */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export const ROOT = path.resolve(import.meta.dirname, '..');
export const DEV_VARS = path.join(ROOT, '.dev.vars');

/** Parses a dotenv-style file (KEY=VALUE, # comments). Missing file → empty. */
export function readEnvFile(file: string): Map<string, string> {
  const values = new Map<string, string>();
  if (!existsSync(file)) return values;
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (match) values.set(match[1]!, match[2]!.replace(/^(["'])(.*)\1$/, '$2'));
  }
  return values;
}

/** Writes KEY=VALUE lines, preserving comments; restrictive permissions where supported. */
export function writeEnvFile(file: string, values: Map<string, string>, header: string): void {
  const lines = [header, ...[...values].map(([key, value]) => `${key}=${value}`), ''];
  writeFileSync(file, lines.join('\n'), { mode: 0o600 });
}

/**
 * Runs the project's Wrangler with optional stdin. Secrets are only ever
 * passed through stdin — never as command-line arguments, which can be
 * visible to other processes.
 */
export function wrangler(args: string[], stdin?: string): Promise<number> {
  const cli = path.join(ROOT, 'node_modules', 'wrangler', 'bin', 'wrangler.js');
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args], {
      cwd: ROOT,
      stdio: [stdin === undefined ? 'inherit' : 'pipe', 'inherit', 'inherit'],
    });
    child.on('error', reject);
    child.on('exit', (code) => {
      resolve(code ?? 1);
    });
    if (stdin !== undefined) child.stdin?.end(stdin);
  });
}

/** Runs Wrangler with output captured (not shown); used for non-interactive probes. */
export function wranglerQuiet(args: string[]): Promise<{ code: number; output: string }> {
  const cli = path.join(ROOT, 'node_modules', 'wrangler', 'bin', 'wrangler.js');
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => (output += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (output += chunk.toString()));
    child.on('error', reject);
    child.on('exit', (code) => {
      resolve({ code: code ?? 1, output });
    });
  });
}

/** True when Wrangler has usable Cloudflare credentials. Prints nothing. */
export async function wranglerAuthenticated(): Promise<boolean> {
  const { code, output } = await wranglerQuiet(['whoami']);
  return code === 0 && !/not authenticated/i.test(output);
}

export async function uploadSecrets(secrets: Record<string, string>): Promise<void> {
  const code = await wrangler(['secret', 'bulk'], JSON.stringify(secrets));
  if (code !== 0)
    throw new Error(
      `wrangler secret bulk failed (exit ${code}). Is Wrangler logged in and the Worker deployed?`,
    );
}
