/**
 * npm run oauth [-- --token-only] [--no-upload] [--dev-vars] [--no-browser] [--show-url]
 *
 * One-off Google authorisation for unattended operation:
 *  1. GOOGLE_CLIENT_ID comes from the environment, .env, or wrangler.jsonc vars
 *     (it is public configuration). GOOGLE_CLIENT_SECRET comes from the
 *     environment or .env.
 *  2. Serves the loopback callback ${REDIRECT_URI} (the single redirect URI
 *     registered on the Google OAuth client) and opens Google's consent page
 *     (authorisation code + PKCE + state).
 *  3. Exchanges the code and checks that a refresh token and every scope were granted.
 *  4. Stores GOOGLE_REFRESH_TOKEN (and GOOGLE_CLIENT_SECRET, unless --token-only)
 *     as Worker secrets through `wrangler secret bulk` on stdin.
 *
 * The refresh token is never printed, logged or written to disk (unless you
 * pass --dev-vars to use real data in local development).
 */
import { spawn } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import path from 'node:path';
import {
  HEALTH_SCOPES,
  buildAuthorizationUrl,
  createPkcePair,
  exchangeAuthorizationCode,
  missingScopes,
  randomUrlSafe,
} from '../src/google/oauth';
import { unstable_readConfig } from 'wrangler';
import { DEV_VARS, ROOT, readEnvFile, uploadSecrets, wranglerAuthenticated, writeEnvFile } from './lib';

const args = process.argv.slice(2);
/** Must match the one redirect URI registered on the Google OAuth client exactly. */
const PORT = 8976;
const REDIRECT_URI = `http://localhost:${PORT}/oauth/callback`;

/** GOOGLE_CLIENT_ID is ordinary configuration, so it may live in wrangler.jsonc vars. */
function clientIdFromWranglerConfig(): string | undefined {
  try {
    // Only `vars` is needed; narrowing avoids depending on Wrangler's internal config types.
    const config = unstable_readConfig({ config: path.join(ROOT, 'wrangler.jsonc') }) as {
      vars?: Record<string, unknown>;
    };
    const value = config.vars?.GOOGLE_CLIENT_ID;
    return typeof value === 'string' && value.trim() ? value.trim() : undefined;
  } catch {
    return undefined;
  }
}
const TIMEOUT_MS = 15 * 60_000;

const page = (title: string, message: string) =>
  `<!doctype html><meta charset="utf-8"><title>${title}</title>` +
  `<body style="font-family:system-ui;max-width:32rem;margin:4rem auto;line-height:1.5">` +
  `<h1>${title}</h1><p>${message}</p></body>`;

function openBrowser(url: string): void {
  // rundll32 avoids cmd.exe re-parsing the '&' characters in the URL.
  const [command, commandArgs] =
    process.platform === 'win32'
      ? ['rundll32', ['url.dll,FileProtocolHandler', url]]
      : process.platform === 'darwin'
        ? ['open', [url]]
        : ['xdg-open', [url]];
  spawn(command, commandArgs, { stdio: 'ignore', detached: true })
    .on('error', () => undefined)
    .unref();
}

function waitForCode(expectedState: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const servers: Server[] = [];
    const finish = (error: Error | null, code?: string) => {
      clearTimeout(timer);
      for (const server of servers) server.close();
      if (error) reject(error);
      else resolve(code!);
    };
    const handler: Parameters<typeof createServer>[1] = (request, response) => {
      const url = new URL(request.url ?? '/', REDIRECT_URI);
      if (url.pathname !== '/oauth/callback') {
        response.writeHead(404).end();
        return;
      }
      const state = url.searchParams.get('state');
      const code = url.searchParams.get('code');
      const denied = url.searchParams.get('error');
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      if (denied) {
        response.end(
          page('Not connected', 'Google reported that access was not granted. You can close this tab.'),
        );
        finish(new Error(`Google returned "${denied}". Nothing was stored.`));
      } else if (!code || state !== expectedState) {
        response.end(
          page('Not connected', 'This callback did not match the request. Please run npm run oauth again.'),
        );
        finish(new Error('State mismatch or missing code; ignoring this callback.'));
      } else {
        response.end(page('PulseWatch is connected', 'You can close this tab and return to the terminal.'));
        finish(null, code);
      }
    };
    const timer = setTimeout(() => {
      finish(new Error('Timed out after 15 minutes waiting for Google to redirect back.'));
    }, TIMEOUT_MS);
    // Listen on IPv4 and IPv6 loopback: browsers may resolve "localhost" to either.
    for (const host of ['127.0.0.1', '::1']) {
      const server = createServer(handler);
      server.on('error', (error: NodeJS.ErrnoException) => {
        if (host === '::1' && (error.code === 'EADDRNOTAVAIL' || error.code === 'EAFNOSUPPORT')) return;
        finish(new Error(`Could not listen on ${host}:${PORT} (${error.code ?? error.message}).`));
      });
      server.listen(PORT, host);
      servers.push(server);
    }
  });
}

async function main(): Promise<void> {
  const fileVars = readEnvFile(path.join(ROOT, '.env'));
  const configuredClientId = clientIdFromWranglerConfig();
  const clientId = process.env.GOOGLE_CLIENT_ID ?? fileVars.get('GOOGLE_CLIENT_ID') ?? configuredClientId;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET ?? fileVars.get('GOOGLE_CLIENT_SECRET');
  if (!clientId) {
    throw new Error('Set GOOGLE_CLIENT_ID in wrangler.jsonc vars (it is not a secret) or in .env.');
  }
  if (!clientSecret) {
    throw new Error('Provide GOOGLE_CLIENT_SECRET via the environment or .env (git-ignored).');
  }
  if (configuredClientId !== clientId) {
    console.warn(
      'Note: the Worker reads GOOGLE_CLIENT_ID from wrangler.jsonc vars. Set it there (and deploy) so the ' +
        'Worker refreshes tokens with the same client.',
    );
  }

  // Check the upload path first, so a consent is never wasted on a token that can't be stored.
  if (!args.includes('--no-upload') && !(await wranglerAuthenticated())) {
    throw new Error('Wrangler is not logged in. Run `npx wrangler login` first, then npm run oauth again.');
  }

  const state = randomUrlSafe(24);
  const pkce = await createPkcePair();
  const url = buildAuthorizationUrl({
    clientId,
    redirectUri: REDIRECT_URI,
    state,
    codeChallenge: pkce.challenge,
  });

  // The URL carries the client id, state and PKCE challenge: shown only on request.
  if (args.includes('--show-url') || args.includes('--no-browser')) {
    console.log(`Open this URL to continue:\n\n  ${url}\n`);
  } else {
    console.log('Opening Google consent in your browser (run with --show-url to print the link instead).');
  }
  console.log(`Waiting for the redirect to ${REDIRECT_URI} …`);
  const codePromise = waitForCode(state);
  if (!args.includes('--no-browser')) openBrowser(url);
  const code = await codePromise;

  const token = await exchangeAuthorizationCode((input, init) => fetch(input, init), {
    clientId,
    clientSecret,
    code,
    codeVerifier: pkce.verifier,
    redirectUri: REDIRECT_URI,
  });
  if (!token.refreshToken) {
    throw new Error(
      'Google did not return a refresh token. Remove PulseWatch at https://myaccount.google.com/permissions and run again.',
    );
  }
  const missing = missingScopes(token.scopes);
  if (missing.includes(HEALTH_SCOPES.healthMetrics)) {
    throw new Error(
      'The heart-rate/health metrics permission was not granted; PulseWatch cannot work without it.',
    );
  }
  if (missing.length > 0) {
    console.warn(
      `\nWarning: some permissions were not granted, so related features will be limited:\n  ${missing.join('\n  ')}`,
    );
  }
  if (token.refreshTokenExpiresInSeconds !== null) {
    const days = Math.round(token.refreshTokenExpiresInSeconds / 86_400);
    console.warn(
      `\nWarning: Google granted time-limited access (about ${days} day(s)). For unattended use, set the OAuth app's ` +
        'publishing status to "In production" and run npm run oauth again.',
    );
  }

  // GOOGLE_CLIENT_ID is configuration, not a secret: it lives in wrangler.jsonc vars.
  const secrets: Record<string, string> = { GOOGLE_REFRESH_TOKEN: token.refreshToken };
  if (!args.includes('--token-only')) secrets.GOOGLE_CLIENT_SECRET = clientSecret;
  if (args.includes('--dev-vars')) {
    const devVars = readEnvFile(DEV_VARS);
    devVars.set('GOOGLE_CLIENT_ID', clientId);
    for (const [key, value] of Object.entries(secrets)) devVars.set(key, value);
    writeEnvFile(
      DEV_VARS,
      devVars,
      '# Local secrets for PulseWatch. Never commit this file (it is git-ignored).',
    );
    console.log('\nSaved the Google credentials to .dev.vars for local development.');
  }
  if (args.includes('--no-upload')) {
    console.log('\nSkipped uploading to Cloudflare (--no-upload).');
  } else {
    console.log(`\nStoring ${Object.keys(secrets).join(' and ')} as Worker secrets…`);
    await uploadSecrets(secrets);
  }
  const granted = token.scopes.map((scope) => scope.replace(/^https:\/\/www\.googleapis\.com\/auth\//, ''));
  console.log(`\nGranted scopes (${granted.length}): ${granted.join(', ')}`);
  console.log(
    'Done. The refresh token was not displayed or saved to disk. It has no fixed lifetime for an app in ' +
      'production, but stops working if access is revoked or it goes unused for six months; PulseWatch then ' +
      'asks you to run npm run oauth again.',
  );
}

main().catch((error: unknown) => {
  console.error(`\n${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
