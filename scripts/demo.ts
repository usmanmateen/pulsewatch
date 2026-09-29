/**
 * npm run demo [scenario ...] [--list] [--json] [--send] [--verbose]
 *
 * Runs synthetic scenarios through the production pipeline against a local,
 * throwaway D1 database (via Wrangler's platform proxy) and prints what the
 * phone would have received. No Google account, Cloudflare account or real
 * health data involved.
 *
 *   --send     also publish the resulting notifications to your ntfy topic
 *              (NTFY_TOPIC from the environment or .dev.vars), titled "[DEMO]"
 *   --json     machine-readable output
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { getPlatformProxy } from 'wrangler';
import { runScenario, type ScenarioEvent, type ScenarioRun } from '../src/demo/runner';
import { SCENARIOS, findScenario, type Scenario } from '../src/demo/scenarios';
import { NtfyProvider } from '../src/notifications/ntfy';
import { createLogger } from '../src/observability/log';

const ROOT = path.resolve(import.meta.dirname, '..');

const EMOJI: Record<string, string> = {
  watch: '⌚',
  battery: '🔋',
  grey_question: '❔',
  sleeping: '😴',
  sunny: '☀️',
  heart: '❤️',
  chart_with_downwards_trend: '📉',
  chart_with_upwards_trend: '📈',
  walking: '🚶',
  warning: '⚠️',
  hourglass: '⌛',
  white_check_mark: '✅',
};
const PRIORITY: Record<number, string> = { 1: 'min', 2: 'low', 3: 'default', 4: 'high', 5: 'urgent' };

const color = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code: number, text: string) => (color ? `\u001b[${code}m${text}\u001b[0m` : text);
const bold = (text: string) => paint(1, text);
const dim = (text: string) => paint(2, text);
const green = (text: string) => paint(32, text);
const yellow = (text: string) => paint(33, text);
const cyan = (text: string) => paint(36, text);

function readDevVars(): Record<string, string> {
  const file = path.join(ROOT, '.dev.vars');
  if (!existsSync(file)) return {};
  const vars: Record<string, string> = {};
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (match) vars[match[1]!] = match[2]!.replace(/^["']|["']$/g, '');
  }
  return vars;
}

function wrap(text: string, width: number, indent: string): string {
  const lines: string[] = [];
  for (const paragraph of text.split('\n')) {
    let line = '';
    for (const word of paragraph.split(' ')) {
      if (line && (line + ' ' + word).length > width) {
        lines.push(line);
        line = word;
      } else {
        line = line ? `${line} ${word}` : word;
      }
    }
    lines.push(line);
  }
  return lines.map((l) => indent + l).join('\n');
}

async function applyMigrations(db: D1Database): Promise<void> {
  const dir = path.join(ROOT, 'migrations');
  for (const file of readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort()) {
    const sql = readFileSync(path.join(dir, file), 'utf8')
      .split('\n')
      .filter((line) => !line.trim().startsWith('--'))
      .join('\n');
    for (const statement of sql
      .split(/;\s*(?:\n|$)/)
      .map((s) => s.trim())
      .filter(Boolean)) {
      await db.prepare(statement).run();
    }
  }
}

function describeCheck(event: Extract<ScenarioEvent, { type: 'check' }>): string {
  const wear = (event.result.rules.deviceOffWrist ?? '').split(':').slice(1).join(':') || '—';
  const notable = Object.entries(event.result.rules)
    .filter(([id, status]) => id !== 'deviceOffWrist' && /^(alerting|pending)/.test(status))
    .map(([id, status]) => `${id} ${status}`);
  const wearText = wear.startsWith('NORMAL') ? green(wear) : yellow(wear);
  return `${cyan(event.clock)}  wear ${wearText}${notable.length ? dim(`  · ${notable.join(' · ')}`) : ''}`;
}

function printRun(run: ScenarioRun): void {
  const { scenario } = run;
  console.log(`\n${bold(`━━ ${scenario.title} `.padEnd(72, '━'))}`);
  console.log(dim(scenario.description));
  console.log();
  for (const event of run.events) {
    switch (event.type) {
      case 'check':
        console.log(` ${describeCheck(event)}`);
        break;
      case 'delivered': {
        const m = event.message;
        const icon = m.tags.map((t) => EMOJI[t] ?? '').join('');
        console.log(
          `        📲 ${bold(`${icon} ${m.title}`)} ${dim(`[${PRIORITY[m.priority] ?? m.priority}]`)}`,
        );
        console.log(wrap(m.message, 64, '           '));
        break;
      }
      case 'cleared':
        console.log(`        🧹 ${green('notification cleared from phone')} ${dim(`(${event.sequenceId})`)}`);
        break;
      case 'rejected':
        console.log(
          `        ⛔ ${yellow(`ntfy rejected: HTTP ${event.status}${event.code ? ` code ${event.code}` : ''}`)}`,
        );
        break;
      case 'retry_scheduled':
        console.log(
          `        ↻  ${dim(`queue retry in ${Math.round(event.delaySeconds / 60)} min (${event.delaySeconds}s)`)}`,
        );
        break;
      case 'duplicate_ignored':
        console.log(`        ♊ ${dim(`duplicate queue delivery ignored (${event.count})`)}`);
        break;
    }
  }
  console.log(
    dim(
      `\n  ${run.delivered.length} delivered · ${run.cleared.length} cleared · ${run.rejected} rejected · ` +
        `${run.duplicatesIgnored} duplicates ignored`,
    ),
  );
}

async function sendToNtfy(runs: ScenarioRun[]): Promise<void> {
  const vars = { ...readDevVars(), ...process.env };
  const topic = vars.NTFY_TOPIC;
  if (!topic) throw new Error('--send needs NTFY_TOPIC (environment or .dev.vars)');
  const provider = new NtfyProvider({
    baseUrl: (vars.NTFY_URL ?? 'https://ntfy.sh').replace(/\/+$/, ''),
    topic,
    token: vars.NTFY_TOKEN ?? null,
    fetch: (input, init) => fetch(input, init),
    titlePrefix: '[DEMO] ',
  });
  let sent = 0;
  for (const run of runs) {
    for (const message of run.delivered) {
      const result = await provider.send({
        id: `demo-${run.scenario.id}-${sent}`,
        title: message.title,
        body: message.message,
        tags: message.tags,
        severity: message.priority >= 4 ? 'warning' : message.priority <= 2 ? 'info' : 'notice',
      });
      console.log(
        `  ${result.outcome === 'delivered' ? green('sent') : yellow(result.outcome)}  ${message.title}`,
      );
      sent += 1;
    }
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes('--list')) {
    for (const s of SCENARIOS) console.log(`${s.id.padEnd(28)} ${s.description}`);
    return;
  }
  const ids = args.filter((a) => !a.startsWith('--'));
  const selected: Scenario[] =
    ids.length === 0
      ? [...SCENARIOS]
      : ids.map((id) => {
          const scenario = findScenario(id);
          if (!scenario) throw new Error(`Unknown scenario "${id}". Try --list.`);
          return scenario;
        });

  const proxy = await getPlatformProxy<{ DB: D1Database }>({
    configPath: path.join(ROOT, 'wrangler.jsonc'),
    persist: false,
  });
  try {
    await applyMigrations(proxy.env.DB);
    const verbose = args.includes('--verbose');
    const log = verbose ? createLogger({ service: 'pulsewatch-demo' }) : undefined;
    const runs: ScenarioRun[] = [];
    for (const scenario of selected) {
      runs.push(await runScenario(scenario, { db: proxy.env.DB, ...(log ? { log } : {}) }));
    }
    if (args.includes('--json')) {
      console.log(JSON.stringify(runs, null, 2));
    } else {
      console.log(bold('PulseWatch demo — synthetic data only, production pipeline'));
      runs.forEach(printRun);
    }
    if (args.includes('--send')) {
      console.log(`\n${bold('Publishing demo notifications to ntfy…')}`);
      await sendToNtfy(runs);
    }
  } finally {
    await proxy.dispose();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
