/**
 * Live probe of the Полтаваобленерго endpoints through the web client (src/services/poeClient.ts):
 * prints today's and tomorrow's queue table, the active measures, one per-house status and the
 * emergencies of one branch registry. Exits with 1 when today's schedule or the per-house status
 * can not be read, so a format change on poe.pl.ua shows up in CI (.github/workflows/poe-data.yml).
 *
 * Run: npx tsx scripts/poe-live-probe.ts
 */
import { fromInstant, plusDays, toLocalDate, formatLocalDate } from '../src/core/localTime';
import { POE_QUEUES } from '../src/core/poeSchedule';
import type { ScheduleCell } from '../src/core/outageModels';
import { PoeClient, fetchPoeTransport, type ScheduleFetch } from '../src/services/poeClient';

// Sample address of the probe: місто Полтава (11389), вул. Соборності (1227174), house 1, branch 123/23
const SAMPLE = { cityId: 11389, streetId: 1227174, house: '1', registryId: 23 };

const symbol: Record<ScheduleCell, string> = { ON: '.', OFF: '#', SWITCHING: '~' };

function printTable(label: string, r: ScheduleFetch): void {
  console.log(`\n${label}`);
  if (r.kind === 'unavailable') {
    console.log(`  unavailable: ${r.reason}`);
    return;
  }
  if (r.table.kind === 'NOT_PUBLISHED') {
    console.log('  not published yet');
    return;
  }
  console.log(`  stamp: ${r.table.stamp ?? '-'}    legend: # off, ~ switching, . on`);
  console.log('        00    03    06    09    12    15    18    21');
  for (const q of POE_QUEUES) console.log(`  ${q}  ${r.table.queues[q].map((c) => symbol[c]).join('')}`);
}

(async () => {
  const today = toLocalDate(fromInstant(Date.now()));
  const client = new PoeClient(fetchPoeTransport());
  let failed = false;

  const todayTable = await client.schedule(today);
  printTable(`Schedule ${formatLocalDate(today)}`, todayTable);
  if (todayTable.kind === 'unavailable') failed = true;
  printTable(`Schedule ${formatLocalDate(plusDays(today, 1))}`, await client.schedule(plusDays(today, 1)));

  const measures = await client.measures(today);
  console.log('\nActive measures');
  if (measures.kind === 'unavailable') console.log(`  unavailable: ${measures.reason}`);
  else if (measures.measures.length === 0) console.log('  none');
  else for (const m of measures.measures) {
    const p2 = (n: number) => String(n).padStart(2, '0');
    console.log(`  ${m.type} ${p2(m.beginHour)}:${p2(m.beginMinute)}-${p2(m.endHour)}:${p2(m.endMinute)} ${m.reason ?? ''}`);
  }

  const status = await client.addressStatus(SAMPLE.cityId, SAMPLE.streetId, SAMPLE.house, today);
  console.log('\nPer-house status (місто Полтава, вул. Соборності 1)');
  if (status.kind === 'unavailable') {
    console.log(`  unavailable: ${status.reason}`);
    failed = true;
  } else {
    const s = status.status;
    console.log(
      `  message_type ${s.messageType}, queue ${s.queue ?? 'none'}, emergency ${s.emergency?.id ?? 'none'}, ` +
        `schedule mirror ${s.scheduleMirror ? 'yes' : 'no'}, repairs ${s.repairs.length}`
    );
  }

  const registry = await client.registry(SAMPLE.registryId, today);
  console.log(`\nRegistry of branch ${SAMPLE.registryId}`);
  if (registry.kind === 'unavailable') console.log(`  unavailable: ${registry.reason}`);
  else {
    const byKind = (k: string) => registry.rows.filter((r) => r.kind === k).length;
    console.log(`  ${registry.rows.length} rows: ${byKind('EMERGENCY')} emergency, ${byKind('REPAIR')} repair, ${byKind('MIRROR')} schedule mirror`);
  }

  if (failed) {
    console.error('\nPOE live probe FAILED: today\'s schedule or the per-house status could not be read');
    process.exit(1);
  }
  console.log('\nPOE live probe OK');
})();
