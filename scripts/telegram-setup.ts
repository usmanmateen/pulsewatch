/**
 * npm run telegram:setup [-- --token-file <path>] [--no-upload] [--dev-vars]
 *
 * Connects PulseWatch to your own Telegram bot:
 *  1. Reads the bot token from @BotFather: from the clipboard (press Enter),
 *     pasted at a hidden prompt, or from --token-file.
 *  2. Checks it with Telegram (getMe) and shows the bot's username.
 *  3. Waits up to 10 minutes for you to press Start in the bot's chat and
 *     takes the chat id from that message.
 *  4. Stores TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID as Worker secrets
 *     (`wrangler secret bulk` on stdin) and sends a confirmation message.
 *
 * Neither value is printed, logged or written to disk (unless --dev-vars).
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { TELEGRAM_CHAT_ID_PATTERN, TELEGRAM_TOKEN_PATTERN } from '../src/env';
import { TELEGRAM_API, TelegramProvider } from '../src/notifications/telegram';
import { DEV_VARS, readEnvFile, uploadSecrets, wranglerAuthenticated, writeEnvFile } from './lib';

const args = process.argv.slice(2);
const WAIT_MS = 10 * 60_000;

function optionValue(name: string): string | null {
  const index = args.indexOf(name);
  if (index < 0) return null;
  const value = args[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${name} needs a value.`);
  return value;
}

/**
 * Finds a BotFather token anywhere in `text`. Pastes can arrive wrapped in
 * bracketed-paste markers, with surrounding words, or split across lines.
 */
function findToken(text: string): string | null {
  const match = /\d{5,15}:[A-Za-z0-9_-]{30,64}/.exec(text);
  return match && TELEGRAM_TOKEN_PATTERN.test(match[0]) ? match[0] : null;
}

/** The clipboard's text, or '' if it cannot be read. */
function readClipboard(): string {
  const commands: Array<[string, string[]]> =
    process.platform === 'win32'
      ? [['powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Get-Clipboard -Raw']]]
      : process.platform === 'darwin'
        ? [['pbpaste', []]]
        : [
            ['wl-paste', ['--no-newline']],
            ['xclip', ['-selection', 'clipboard', '-o']],
          ];
  for (const [command, commandArgs] of commands) {
    const result = spawnSync(command, commandArgs, { encoding: 'utf8', timeout: 5000 });
    if (result.status === 0 && typeof result.stdout === 'string') return result.stdout;
  }
  return '';
}

/**
 * Reads input until Enter without echoing anything, and returns all of it
 * (including anything pasted after a line break in the same burst). In raw
 * mode Ctrl+V reaches the program as a control character rather than a
 * paste, so the caller falls back to the clipboard. Ctrl+C cancels.
 */
function readHidden(question: string): Promise<string> {
  const { stdin, stdout } = process;
  if (!stdin.isTTY) {
    return new Promise((resolve, reject) => {
      let data = '';
      stdin.setEncoding('utf8');
      stdin.on('data', (chunk: string) => (data += chunk));
      stdin.on('end', () => {
        resolve(data);
      });
      stdin.on('error', reject);
    });
  }
  return new Promise((resolve, reject) => {
    stdout.write(question);
    let received = '';
    const finish = (error: Error | null) => {
      stdin.off('data', onData);
      stdin.setRawMode(false);
      stdin.pause();
      stdout.write('\n');
      if (error) reject(error);
      else resolve(received);
    };
    const onData = (chunk: string) => {
      if (chunk.includes('\u0003')) {
        finish(new Error('Cancelled.'));
        return;
      }
      for (const ch of chunk) {
        if (ch === '\u007f' || ch === '\b') received = received.slice(0, -1);
        else received += ch;
      }
      if (/[\r\n]/.test(chunk)) finish(null);
    };
    stdin.setRawMode(true);
    stdin.setEncoding('utf8');
    stdin.resume();
    stdin.on('data', onData);
  });
}

interface BotApiResponse<T> {
  ok: boolean;
  result?: T;
  description?: string;
  error_code?: number;
}

/** Calls the Bot API. Errors mention the method and Telegram's description, never the URL. */
async function botApi<T>(token: string, method: string, params: Record<string, unknown> = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${TELEGRAM_API}/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
      signal: AbortSignal.timeout(45_000),
    });
  } catch {
    throw new Error(`Could not reach Telegram (${method}). Check your internet connection.`);
  }
  const body = (await response.json().catch(() => ({ ok: false }))) as BotApiResponse<T>;
  if (!body.ok || body.result === undefined) {
    if (response.status === 401 || response.status === 404) {
      throw new Error('Telegram rejected the bot token. Copy it again from @BotFather.');
    }
    if (response.status === 409) {
      throw new Error('This bot has a webhook set, so its messages cannot be read here. Create a new bot.');
    }
    throw new Error(`Telegram ${method} failed: ${String(body.description ?? response.status)}`);
  }
  return body.result;
}

interface Update {
  update_id: number;
  message?: { text?: string; chat?: { id?: number; type?: string } };
}

async function waitForStart(token: string): Promise<string> {
  const deadline = Date.now() + WAIT_MS;
  let offset: number | undefined;
  while (Date.now() < deadline) {
    const updates = await botApi<Update[]>(token, 'getUpdates', {
      timeout: 30,
      allowed_updates: ['message'],
      ...(offset === undefined ? {} : { offset }),
    });
    for (const update of updates) {
      offset = update.update_id + 1;
      const chat = update.message?.chat;
      if (
        chat?.type === 'private' &&
        typeof chat.id === 'number' &&
        update.message?.text?.startsWith('/start')
      ) {
        // Acknowledge the updates read so far so they are not delivered again.
        await botApi(token, 'getUpdates', { offset, timeout: 0 });
        return String(chat.id);
      }
    }
  }
  throw new Error('No Start message arrived within 10 minutes. Run npm run telegram:setup again.');
}

async function main(): Promise<void> {
  const upload = !args.includes('--no-upload');
  if (upload && !(await wranglerAuthenticated())) {
    throw new Error('Wrangler is not logged in. Run `npx wrangler login` first.');
  }

  const tokenFile = optionValue('--token-file');
  const input = tokenFile
    ? readFileSync(tokenFile, 'utf8')
    : await readHidden(
        'Copy the bot token from @BotFather, then press Enter here to read it from the clipboard\n' +
          '(or paste it first; nothing is shown): ',
      );
  let token = findToken(input);
  if (!token && !tokenFile) {
    token = findToken(readClipboard());
    if (token) console.log('Read the token from the clipboard.');
  }
  if (!token) {
    // Only the length is reported: the input may be (part of) a secret.
    throw new Error(
      `No bot token found in what was entered (${String(input.length)} characters) or in the clipboard. ` +
        "In Telegram, tap the token in BotFather's message to copy it, then run this again and press Enter.",
    );
  }

  const bot = await botApi<{ username?: string }>(token, 'getMe');
  const username = bot.username ?? 'your bot';
  console.log(`\nToken accepted for @${username}.`);
  console.log(`Now open Telegram, go to https://t.me/${username} and press Start (or send /start).`);
  console.log('Waiting for your message…');
  const chatId = await waitForStart(token);
  if (!TELEGRAM_CHAT_ID_PATTERN.test(chatId)) throw new Error('Telegram returned an unexpected chat id.');
  console.log('Found your chat.');

  const secrets = { TELEGRAM_BOT_TOKEN: token, TELEGRAM_CHAT_ID: chatId };
  if (args.includes('--dev-vars')) {
    const devVars = readEnvFile(DEV_VARS);
    for (const [key, value] of Object.entries(secrets)) devVars.set(key, value);
    writeEnvFile(
      DEV_VARS,
      devVars,
      '# Local secrets for PulseWatch. Never commit this file (it is git-ignored).',
    );
    console.log('Saved both values to .dev.vars for local development.');
  }
  if (upload) {
    console.log('Storing TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID as Worker secrets…');
    await uploadSecrets(secrets);
  }

  const provider = new TelegramProvider({
    botToken: token,
    chatId,
    fetch: (input, init) => fetch(input, init),
  });
  const sent = await provider.send({
    id: 'setup',
    title: 'PulseWatch is connected',
    body: 'Alerts from PulseWatch will arrive in this chat.',
    tags: ['white_check_mark'],
    severity: 'notice',
  });
  if (sent.outcome !== 'delivered') {
    throw new Error(`Secrets were stored, but the confirmation message failed (${sent.outcome}).`);
  }
  console.log(
    '\nDone: a confirmation message is in your Telegram chat. With NOTIFY_PROVIDER set to "telegram" in ' +
      'wrangler.jsonc, deploy (npx wrangler deploy) and PulseWatch will use it. Neither value was displayed.',
  );
}

main().catch((error: unknown) => {
  console.error(`\n${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
