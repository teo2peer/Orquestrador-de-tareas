// Claude Code statusLine command of every orq agent (orq sets it in each agent's settings.json):
// records the account usage for orq and prints a short line. Must never fail or block the
// agent's terminal: it gives up after 1 s.
import { recordUsage, usageLine } from './usage.ts';

const TIMEOUT_MS = 1000;
setTimeout(() => {
  process.stdout.write('orq\n');
  process.exit(0);
}, TIMEOUT_MS).unref();

let line = 'orq';
try {
  const json = JSON.parse(await Bun.stdin.text());
  recordUsage(json);
  line = usageLine(json);
} catch {
  /* bad or empty input: keep the default line */
}
process.stdout.write(line + '\n');
process.exit(0);

export {};
