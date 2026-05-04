/**
 * Manual KB-verification helper. Usage:
 *   npm run demo:inspect-battle-stats -- <battleId> <zoneId>
 *
 * Fetches a real battle-stats response and prints its `division.bar`,
 * `division.domination`, and per-country `division.{id}.{zoneId}.domination`
 * fields. Use the output to confirm the polling engine's domination-units
 * assumption (currently: per-country domination is treated as 0–1800 round
 * points). If real values appear ≤ 100, the assumption is wrong and
 * `src/poll/eta.ts` needs adjustment (multiply by 18 if percentage).
 */
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AuthManager, ErepClient, FileSessionStore } from '../src/erep/index.js';

const battleId = Number(process.argv[2]);
const zoneId = Number(process.argv[3]);
if (!battleId || !zoneId) {
  console.error('Usage: npm run demo:inspect-battle-stats -- <battleId> <zoneId>');
  process.exit(1);
}

const email = process.env['EREP_EMAIL'];
const password = process.env['EREP_PASSWORD'];
if (!email || !password) {
  console.error('EREP_EMAIL and EREP_PASSWORD must be set');
  process.exit(1);
}

const repoRoot = resolve(fileURLToPath(import.meta.url), '..', '..');
const sessionPath = resolve(repoRoot, 'data', 'session.json');

const auth = new AuthManager({ email, password, store: new FileSessionStore(sessionPath) });
const client = new ErepClient({ auth });

const res = await client.getBattleStats(battleId, zoneId, 11);
const zoneKey = String(zoneId);
if (!res.division) {
  console.log('division: <missing in response>');
  process.exit(0);
}
console.log('division.bar:', res.division.bar);
console.log('division.domination:', res.division.domination);
console.log('zone_finished:', res.zone_finished);
console.log('per-country domination:');
for (const key of Object.keys(res.division)) {
  if (!/^[0-9]+$/.test(key)) continue;
  const entry = (res.division as Record<string, unknown>)[key] as Record<string, unknown> | undefined;
  if (!entry) continue;
  const z = entry[zoneKey] as { domination?: number; won?: number } | undefined;
  if (z) console.log(`  country ${key}: domination=${z.domination}, won=${z.won}`);
}
console.log("NOTE: if any per-country domination value > 100, the engine's 0-1800 assumption is correct.");
console.log('      If all values are ≤ 100, treat them as percentage and multiply by 18 in src/poll/eta.ts.');
