/**
 * npm run secrets:init [-- --upload] [--new-topic] [--include-ntfy] [--ntfy-topic-file <path>]
 *
 * Generates the secrets PulseWatch creates for itself and keeps them in
 * .dev.vars (git-ignored). Values are never printed.
 *
 *   STATUS_TOKEN   bearer token for /status and /admin/* (always; existing value kept)
 *   NTFY_TOPIC     unguessable topic name, only with --new-topic. If you already
 *                  have a topic (on public ntfy.sh it is effectively a password),
 *                  use --ntfy-topic-file or `npx wrangler secret put NTFY_TOPIC`.
 *
 * --upload stores STATUS_TOKEN as a Worker secret (stdin only). The ntfy topic is
 * uploaded only when explicitly requested — --include-ntfy (from .dev.vars) or
 * --ntfy-topic-file (read from a file, never copied into .dev.vars) — so an
 * existing production topic can never be overwritten by accident.
 */
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { DEV_VARS, readEnvFile, uploadSecrets, writeEnvFile } from './lib';

const HEADER =
  '# Local secrets for PulseWatch. Never commit this file (it is git-ignored).\n' +
  '# MODE=demo makes `npm run dev` use synthetic data; delete it to develop against real data.';

const args = process.argv.slice(2);
const TOPIC_PATTERN = /^[A-Za-z0-9_-]{20,64}$/;

function base62(bytes: number): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  // 256 is not a multiple of 62; rejection sampling keeps characters uniform.
  const out: string[] = [];
  while (out.length < bytes) {
    for (const byte of randomBytes(bytes)) {
      if (byte < 248 && out.length < bytes) out.push(alphabet[byte % 62]!);
    }
  }
  return out.join('');
}

function optionValue(name: string): string | null {
  const index = args.indexOf(name);
  if (index < 0) return null;
  const value = args[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${name} needs a value.`);
  return value;
}

/** Reads a topic from a file without echoing it; the error never includes the content. */
function readTopicFile(file: string): string {
  let topic: string;
  try {
    topic = readFileSync(file, 'utf8').trim();
  } catch {
    throw new Error(`Could not read the ntfy topic file at ${file}.`);
  }
  if (!TOPIC_PATTERN.test(topic)) {
    throw new Error('The ntfy topic file does not contain a valid topic (20-64 of A-Z a-z 0-9 - _).');
  }
  return topic;
}

async function main(): Promise<void> {
  const values = readEnvFile(DEV_VARS);
  const created: string[] = [];
  if (!values.has('MODE')) values.set('MODE', 'demo');
  if (!values.get('STATUS_TOKEN')) {
    values.set('STATUS_TOKEN', randomBytes(32).toString('base64url'));
    created.push('STATUS_TOKEN');
  }
  if (args.includes('--new-topic')) {
    if (values.get('NTFY_TOPIC'))
      throw new Error('.dev.vars already has NTFY_TOPIC; remove it first to replace it.');
    // 32 base62 characters ≈ 190 bits: not guessable, still easy to paste into the ntfy app.
    values.set('NTFY_TOPIC', `pulsewatch-${base62(32)}`);
    created.push('NTFY_TOPIC');
  }
  writeEnvFile(DEV_VARS, values, HEADER);
  console.log(
    created.length
      ? `Generated ${created.join(' and ')} in .dev.vars (values not shown).`
      : 'Nothing to generate; existing values in .dev.vars were kept.',
  );

  const topicFile = optionValue('--ntfy-topic-file');
  if (topicFile && !args.includes('--upload'))
    throw new Error('--ntfy-topic-file is only used with --upload.');

  if (args.includes('--upload')) {
    const secrets: Record<string, string> = { STATUS_TOKEN: values.get('STATUS_TOKEN')! };
    if (topicFile) {
      secrets.NTFY_TOPIC = readTopicFile(topicFile);
    } else if (args.includes('--include-ntfy')) {
      const topic = values.get('NTFY_TOPIC');
      if (!topic) throw new Error('--include-ntfy needs NTFY_TOPIC in .dev.vars.');
      secrets.NTFY_TOPIC = topic;
      const token = values.get('NTFY_TOKEN');
      if (token) secrets.NTFY_TOKEN = token;
    }
    await uploadSecrets(secrets);
    console.log(`Uploaded ${Object.keys(secrets).join(', ')} to the Worker (values not shown).`);
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
