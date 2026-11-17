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
import { getSettlementsForRem, getStreetsForSettlement, refreshStreets, settlementChoices, updateDirectory, usePoeDirectory, usePoeLookupClient } from '../src/services/poeAddressLookup';
import { PickerIndex } from '../src/components/pickerSearch';
import { companyChoices, parseCatalogue, queuesFor, refreshQueuesIfDue, usePoeQueues } from '../src/services/poeQueues';
import { queueFromStatus } from '../src/services/outageRepository';
import type { QueueHint } from '../src/core/queueCatalogue';
import { NO_QUEUE_TEXT } from '../src/services/poeAddressLookup';

const ROOT = process.cwd();
const fixture = (name: string) => fs.readFileSync(path.join(ROOT, 'spec/fixtures/poe', name), 'utf8');
const today = parseLocalDate('2026-11-16');
const bundled = () => PoeDirectoryIndex.fromJson(fs.readFileSync(path.join(ROOT, 'poe_directory.json'), 'utf8'))!;

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
    // the raw rows are kept so the nearby outages card can store and parse them again
    assert.equal(r.raw.length, r.rows.length);
    assert.deepEqual(r.raw.map((x) => PoeMapper.parseRegistryRow(x)).filter((x) => x !== null), r.rows);
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
  ['scoped refresh adds, never removes, and survives the JSON round trip', async () => {
    const index = bundled();
    const before = index.streetsOf(11389).length;
    const first = index.streetsOf(11389)[0];
    const merged = index
      .withStreets(11389, [[999000001, 'вул. Нова'], [first.id, first.name]])
      .withBranchSettlements(102, [[999000002, 'село Нове'], [11389, 'місто Полтава']]);
    assert.equal(merged.streetsOf(11389).length, before + 1);
    assert.ok(merged.streetsOf(11389).some((s) => s.name === 'вул. Нова'));
    assert.deepEqual(merged.settlement(999000002)?.branchCabinetIds, [102]);
    assert.ok(merged.settlement(11389)?.branchCabinetIds.includes(102));
    assert.equal(merged.settlements.length, index.settlements.length + 1);
    assert.equal(index.withStreets(1, [[5, 'x']]).settlements.length, index.settlements.length);
    // a newer crawl that lost the new street and settlement keeps them from the older index
    const kept = index.keeping(merged);
    assert.equal(kept.streetsOf(11389).length, merged.streetsOf(11389).length);
    assert.deepEqual(kept.settlement(999000002)?.branchCabinetIds, [102]);
    assert.ok(kept.settlement(11389)?.branchCabinetIds.includes(102));
    assert.equal(kept.crawledAt, index.crawledAt);
    const back = PoeDirectoryIndex.fromJson(merged.toJson());
    assert.ok(back !== null);
    assert.equal(back!.crawledAt, merged.crawledAt);
    assert.deepEqual(back!.settlements, merged.settlements);
    assert.deepEqual(back!.branches, merged.branches);
  }],
  ['settlement choices list the branch first, then the whole oblast once', async () => {
    usePoeDirectory(bundled());
    try {
      const choices = settlementChoices('poltavska', 'uk');
      const own = getSettlementsForRem('poltavska');
      assert.deepEqual(choices.slice(0, own.length).map((c) => c.option.id), own.map((s) => s.id));
      assert.ok(choices.slice(0, own.length).every((c) => c.inBranch));
      assert.equal(choices.length, bundled().settlements.length);
      assert.equal(new Set(choices.map((c) => c.option.id)).size, choices.length);
      const zuivtsi = choices.find((c) => c.option.nameUk === 'село Зуївці');
      assert.ok(zuivtsi && !zuivtsi.inBranch && zuivtsi.label.startsWith('село Зуївці · '), zuivtsi?.label);
    } finally {
      usePoeDirectory(null);
    }
  }],
  ['refresh streets asks POE once and a failure changes nothing; a directory download only takes a newer crawl', async () => {
    usePoeDirectory(bundled());
    try {
      const f = fake(() => ok('[{"instance_id":999000003,"instance_name":"вул. Свіжа"}]'));
      usePoeLookupClient(new PoeClient(f.transport));
      assert.equal(await refreshStreets('poltavska', '11389'), true);
      assert.equal(f.calls.length, 1);
      assert.equal(f.calls[0].json.operation_type, 'street');
      assert.equal(f.calls[0].json.filial_id, '123');
      assert.ok(getStreetsForSettlement('11389').some((s) => s.nameUk === 'вул. Свіжа'));
      usePoeLookupClient(new PoeClient(fake(() => ({ kind: 'failed', reason: 'network' })).transport));
      const size = getStreetsForSettlement('11389').length;
      assert.equal(await refreshStreets('poltavska', '11389'), false);
      assert.equal(getStreetsForSettlement('11389').length, size);
      const text = fs.readFileSync(path.join(ROOT, 'poe_directory.json'), 'utf8');
      assert.equal(await updateDirectory(async () => text), 'UP_TO_DATE');
      assert.equal(await updateDirectory(async () => text.replace(/"crawledAt":"[^"]*"/, '"crawledAt":"2099-01-01T00:00:00"')), 'UPDATED');
      assert.equal(await updateDirectory(async () => null), 'FAILED');
    } finally {
      usePoeLookupClient(null);
      usePoeDirectory(null);
    }
  }],

  // poe_queues.json (spec/POE_API.md 8.11): the bundled catalogue, the lookup through the directory, the refresh rule
  ['queue catalogue: bundled file, address lookup, company list', async () => {
    const text = fs.readFileSync(path.join(ROOT, 'poe_queues.json'), 'utf8');
    const cat = parseCatalogue(text);
    assert.ok(cat !== null && cat.entries.length > 5000 && cat.companies.length > 100);
    assert.equal(parseCatalogue('{"entries":[]}'), null, 'an empty catalogue is no catalogue');
    assert.equal(parseCatalogue('not json'), null);
    usePoeDirectory(bundled());
    usePoeQueues(cat);
    try {
      const street = getStreetsForSettlement('11389').find((s) => s.nameUk.includes('Європейська'));
      assert.ok(street, 'Європейська in Poltava');
      const hints = queuesFor({ remId: 'poltavska', settlementId: '11389', streetId: street!.id, house: '88' });
      assert.equal(hints[0]?.queue, '3.1', 'Європейська 88 -> 3.1 (owner check, 2026-11-16)');
      assert.equal(hints[0]?.kind, 'HOUSE');
      const roshen = companyChoices().find((c) => c.name.includes('Кременчуцька кондитерська'));
      assert.deepEqual(roshen?.queues, ['5.2']);
      // the owner's examples of 2026-11-17, through the picker search the dialog uses
      const choices = companyChoices();
      const index = new PickerIndex(choices, 'TEXT', (c) => c.search, (c) => c.context);
      const find = (q: string) => index.search(q).map((c) => `${c.name} ${c.queues.join(',')}`);
      assert.ok(find("М'ясокомбінат").includes("КП «Полтавський м'ясокомбінат» 1.1"), "М'ясокомбінат: Полтава");
      assert.ok(find('Мʼясокомбінат').includes("М'ясокомбінат 5.1"), "the bare row «М'ясокомбінат» is a company");
      assert.ok(find("М'ясокомбінат").includes('ТОВ «Ясні Зорі-Полтавщина» 6.2'), 'the words of the row find the company');
      assert.ok(find('ФОП Ландарь').includes('ФОП Ландарь Ю.І. 5.1'), 'a sole trader without quotes');
      assert.deepEqual(find('ТОВ "ГЛОБИНСЬКИЙ БІОЕНЕРГЕТИЧНИЙ КОМПЛЕКС')[0], 'ТОВ «ГЛОБИНСЬКИЙ БІОЕНЕРГЕТИЧНИЙ КОМПЛЕКС» 2.1', 'an unclosed quote');
      // the PDF says «Школа № 27» and «Д/С № 14», never ЗОШ or ДНЗ
      assert.ok(find('ЗОШ').some((x) => x.startsWith('Школа № 27 ')), 'ЗОШ finds the schools');
      assert.ok(find('Школа 27')[0].startsWith('Школа № 27 '), '«Школа 27» finds «Школа № 27»');
      assert.ok(find('ДНЗ').some((x) => x.startsWith('Дитячий садок № 14 ')), 'ДНЗ finds the kindergartens');
      assert.ok(find('коледж').includes('Медичний фаховий коледж 3.2'));
      assert.ok(find('кафе "Аква"').includes('кафе «Аква» 4.2'), 'a quoted name after a plain word');
      // owner, 2026-11-17: «кафе» listed companies without the word (it was in their PDF rows): names come first,
      // a row hit shows the matched piece, and a row whose piece is only a listed name (the cafés) is left out
      assert.deepEqual(index.searchHits('кафе').map((h) => [h.item.name, h.snippet]), [['кафе «Аква»', null], ['Кафе «Ні пуху, ні пера»', null]]);
      const meat = index.searchHits("М'ясокомбінат");
      const firstRowHit = meat.findIndex((h) => h.snippet !== null);
      assert.ok(firstRowHit > 0 && meat.slice(firstRowHit).every((h) => h.snippet !== null), 'row hits after every name hit');
      for (const h of meat.slice(firstRowHit)) assert.ok(/м'ясокомбінат/i.test(h.snippet!), `the snippet shows the word: ${h.item.name}: ${h.snippet}`);
      assert.equal(meat.find((h) => h.item.name === 'ТОВ «Ясні Зорі-Полтавщина»')?.snippet, 'М\'ясокомбінат ТОВ "Ясні Зорі-Полтавщина" м. Решетилівка');
      const school = choices.find((c) => c.name === 'Школа № 27' && c.town === 'Кременчук');
      assert.equal(school?.label, 'Школа № 27, Кременчук', 'a school is named with its town');
      // a newer copy replaces the bundled one; the same or an older one does not; a failed fetch changes nothing
      assert.equal(await refreshQueuesIfDue(true, 0, async () => text), 'UP_TO_DATE');
      assert.equal(await refreshQueuesIfDue(true, 0, async () => null), 'FAILED');
      const newer = text.replace(/"builtAt":\s*"[^"]*"/, '"builtAt": "2099-01-01T00:00:00Z"').replace(/"sha256":\s*"[^"]*"/, '"sha256": "x"');
      assert.equal(await refreshQueuesIfDue(true, 0, async () => newer), 'UPDATED');
      // not due again within a week
      assert.equal(await refreshQueuesIfDue(false, 1000, async () => { throw new Error('must not fetch'); }), 'UP_TO_DATE');
    } finally {
      usePoeQueues(null);
      usePoeDirectory(null);
    }
  }],

  ['several connections never clears a queue', async () => {
    const q = { remId: 'poltavska', settlementId: '11389', streetId: '1', house: '1' };
    const none = () => [] as QueueHint[];
    const hint = (): QueueHint[] => [
      { queue: '3.1', kind: 'HOUSE', branch: 'poltavska', row: 28, exact: true },
      { queue: '2.2', kind: 'STREET', branch: 'poltavska', row: 3, exact: true },
    ];
    const tie = (): QueueHint[] => [
      { queue: '2.2', kind: 'HOUSE', branch: 'poltavska', row: 4, exact: true },
      { queue: '5.1', kind: 'HOUSE', branch: 'poltavska', row: 19, exact: true },
    ];
    assert.deepEqual(queueFromStatus({ queue: '1.2', severalConnections: false }, q, '4.1', hint), { queue: '1.2', statusText: null });
    assert.deepEqual(queueFromStatus({ queue: null, severalConnections: false }, q, '4.1', hint), { queue: null, statusText: NO_QUEUE_TEXT });
    assert.equal(queueFromStatus({ queue: null, severalConnections: true }, q, '4.1', hint), null, 'a chosen queue stays');
    assert.deepEqual(queueFromStatus({ queue: null, severalConnections: true }, q, null, hint), { queue: '3.1', statusText: null });
    assert.deepEqual(queueFromStatus({ queue: null, severalConnections: true }, q, '', none), { queue: null, statusText: null });
    assert.deepEqual(queueFromStatus({ queue: null, severalConnections: true }, q, null, tie), { queue: null, statusText: null }, 'a tie is left to the user');
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
