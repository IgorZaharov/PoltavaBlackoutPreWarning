/**
 * The web POE client (src/services/poeClient.ts) and directory index against the live answers of
 * 2026-11-16 in spec/fixtures/poe/, replayed by a fake transport. Same cases as
 * android/app/src/test/java/ua/blackout/prewarning/data/poe/PoeClientTest.kt.
 *
 * Run: tsx tests/poe-client.test.ts
 */
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { parseLocalDate, plusDays } from '../src/core/localTime';
import { PoeConfig, PoeClient, type PoeHttpResult, type PoeTransport } from '../src/services/poeClient';
import { PoeDirectoryIndex } from '../src/services/poeDirectory';
import { PoeMapper } from '../src/core/poeMapper';

const ROOT = process.cwd();
const fixture = (name: string) => fs.readFileSync(path.join(ROOT, 'spec/fixtures/poe', name), 'utf8');
const today = parseLocalDate('2026-11-16');

interface Call {
  endpoint: string;
  field: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  json: any;
  timeout: number;
}

function fake(answer: (c: Call) => PoeHttpResult): { transport: PoeTransport; calls: Call[] } {
  const calls: Call[] = [];
  const transport: PoeTransport = async (endpoint, field, json, timeout) => {
    const c = { endpoint, field, json: JSON.parse(json), timeout };
    calls.push(c);
    return answer(c);
  };
  return { transport, calls };
}
const ok = (body: string): PoeHttpResult => ({ kind: 'ok', body });

const tests: [string, () => Promise<void>][] = [
  ['schedule of today is parsed and requested with a hyphen date', async () => {
    const f = fake(() => ok(fixture('poe_newgpv_2026-11-16.html')));
    const r = await new PoeClient(f.transport).schedule(today);
    assert.equal(f.calls[0].endpoint, PoeConfig.SCHEDULE);
    assert.equal(f.calls[0].field, 'seldate');
    assert.equal(f.calls[0].json.date_in, '16-11-2026');
    assert.equal(r.kind, 'ok');
    if (r.kind !== 'ok') return;
    assert.equal(r.table.kind, 'PUBLISHED');
    assert.equal(Object.keys(r.table.queues).length, 12);
    assert.equal(r.table.queues['1.1'][0], 'SWITCHING');
    assert.equal(r.table.queues['1.1'][8], 'OFF');
    assert.equal(r.table.queues['1.1'][14], 'SWITCHING');
  }],
  ['empty body is not published; error body, network failure and a wrong date are unavailable', async () => {
    const empty = await new PoeClient(fake(() => ok('')).transport).schedule(plusDays(today, 1));
    assert.ok(empty.kind === 'ok' && empty.table.kind === 'NOT_PUBLISHED');
    assert.deepEqual(await new PoeClient(fake(() => ok('{"title":"Bad Request","status":400}')).transport).schedule(today), {
      kind: 'unavailable',
      reason: 'error_body',
    });
    assert.deepEqual(await new PoeClient(fake(() => ({ kind: 'failed', reason: 'network' })).transport).schedule(today), {
      kind: 'unavailable',
      reason: 'network',
    });
    assert.deepEqual(await new PoeClient(fake(() => ok(fixture('poe_newgpv_2026-11-16.html'))).transport).schedule(plusDays(today, 1)), {
      kind: 'unavailable',
      reason: 'date_mismatch',
    });
  }],
  ['measures list ГАВ and ГОП', async () => {
    const r = await new PoeClient(fake(() => ok(fixture('poe_unloading_2026-11-16.json'))).transport).measures(today);
    assert.ok(r.kind === 'ok');
    if (r.kind !== 'ok') return;
    assert.deepEqual(r.measures.map((m) => m.type), ['ГАВ', 'ГОП']);
    assert.equal(r.measures[0].beginHour, 8);
    assert.equal(r.measures[0].beginMinute, 54);
    assert.equal(r.measures[0].reason, 'за розпорядженням НЕК «Укренерго»');
    assert.deepEqual(await new PoeClient(fake(() => ok('[]')).transport).measures(today), { kind: 'ok', measures: [] });
    assert.equal((await new PoeClient(fake(() => ok('<html>')).transport).measures(today)).kind, 'unavailable');
  }],
  ['directory drops junk rows and sends the cabinet branch id', async () => {
    const f = fake(() => ok(fixture('poe_cabinet_cities_filial123.json')));
    const r = await new PoeClient(f.transport).cities(123);
    assert.deepEqual(f.calls[0].json, { operation_type: 'city', filial_id: '123', city_id: '', street_id: '' });
    assert.ok(r.kind === 'ok');
    if (r.kind !== 'ok') return;
    assert.ok(r.options.some((o) => o.id === 11389 && o.name === 'місто Полтава'));
    assert.ok(r.options.every((o) => o.name.trim() !== 'село _'));
    const houses = await new PoeClient(fake(() => ok(fixture('poe_cabinet_buildings_poltava_sobornosti.json'))).transport).buildings(123, 11389, 1227174);
    assert.ok(houses.kind === 'ok' && ['1', '11/13'].every((h) => houses.options.some((o) => o.name === h)));
  }],
  ['address status uses the POE key spelling and maps the emergency', async () => {
    const f = fake(() => ok(fixture('poe_result_type3_emergency_noqueue.json')));
    const r = await new PoeClient(f.transport).addressStatus(11143, 1012802, '9', today);
    assert.deepEqual(f.calls[0].json, { cityid: '11143', streerid: '1012802', house: '9' });
    assert.equal(r.kind, 'confirmed');
    if (r.kind !== 'confirmed') return;
    assert.equal(r.status.queue, null);
    assert.equal(r.status.emergency?.id, 'poe_3462256');
    assert.ok(r.gavMessage?.includes('СГАВ'));
    const fetch = PoeClient.emergencyFetch(r, today);
    assert.ok(fetch.type === 'Confirmed' && fetch.records.map((x) => x.id).join() === 'poe_3462256');
  }],
  ['nothing registered is a confirmed empty emergency list', async () => {
    const r = await new PoeClient(fake(() => ok(fixture('poe_result_type0_none.json'))).transport).addressStatus(11389, 1227174, '1', today);
    assert.ok(r.kind === 'confirmed' && r.status.queue === '1.1');
    assert.deepEqual(PoeClient.emergencyFetch(r, today), { type: 'Confirmed', records: [] });
  }],
  ['address status failures are unavailable, never no outage', async () => {
    for (const body of ['[]', '{"status":400}', '<html></html>', '[{"message_type":3,"accident_str":"?"}]']) {
      const r = await new PoeClient(fake(() => ok(body)).transport).addressStatus(1, 2, '3', today);
      assert.equal(r.kind, 'unavailable', body);
      assert.equal(PoeClient.emergencyFetch(r, today).type, 'Unavailable', body);
    }
  }],
  ['address status is reused for 60 seconds', async () => {
    let now = 1_000_000;
    const f = fake(() => ok(fixture('poe_result_type0_none.json')));
    const client = new PoeClient(f.transport, () => now);
    await client.addressStatus(1, 2, '3', today);
    now += 59_000;
    await client.addressStatus(1, 2, '3', today);
    assert.equal(f.calls.length, 1);
    now += 2_000;
    await client.addressStatus(1, 2, '3', today);
    assert.equal(f.calls.length, 2);
  }],
  ['registry parses the branch rows with the longer timeout', async () => {
    const f = fake(() => ok(fixture('poe_gavapi_filial19_2026-11-16.json')));
    const r = await new PoeClient(f.transport).registry(19, today);
    assert.equal(f.calls[0].field, 'disconngav');
    assert.equal(f.calls[0].json.filialid, '19');
    assert.equal(f.calls[0].timeout, PoeConfig.REGISTRY_READ_TIMEOUT_MS);
    assert.ok(r.kind === 'confirmed');
    if (r.kind !== 'confirmed') return;
    assert.equal(r.rows.length, 56);
    const zuivtsi = r.rows.find((row) => row.places.some((p) => p.settlement === 'с.Зуївці'));
    assert.ok(zuivtsi && zuivtsi.kind === 'EMERGENCY');
    assert.equal(PoeMapper.registryMatch(zuivtsi!.places, 'село Зуївці', 'вул. Дружби', '3'), 'STREET');
    assert.equal((await new PoeClient(fake(() => ok('oops')).transport).registry(19, today)).kind, 'unavailable');
  }],
  ['bundled directory snapshot is usable', async () => {
    const index = PoeDirectoryIndex.fromJson(fs.readFileSync(path.join(ROOT, 'poe_directory.json'), 'utf8'));
    assert.ok(index !== null);
    if (index === null) return;
    assert.equal(index.branches.length, 28);
    const poltava = index.settlement(11389);
    assert.equal(poltava?.name, 'місто Полтава');
    assert.equal(poltava?.branchCabinetIds.length, 9);
    assert.equal(index.streetsOf(11389).length, 1044);
    assert.ok(index.settlementsOf(123).some((s) => s.id === 11389));
    assert.ok(index.settlements.every((s) => s.name.trim() !== 'село _'));
    assert.equal(index.branch(123)?.registryId, 23);
    assert.equal(PoeDirectoryIndex.fromJson('{}'), null);
    assert.equal(PoeDirectoryIndex.fromJson('not json'), null);
  }],
];

(async () => {
  let failed = 0;
  for (const [name, run] of tests) {
    try {
      await run();
      console.log(`PASS ${name}`);
    } catch (e) {
      failed++;
      console.error(`FAIL ${name}`);
      console.error(e instanceof Error ? e.message : e);
    }
  }
  if (failed > 0) {
    console.error(`${failed} POE client test(s) failed`);
    process.exit(1);
  }
  console.log(`All ${tests.length} POE client tests passed`);
})();
