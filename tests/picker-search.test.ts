/**
 * Cases of android/app/src/test/java/ua/blackout/prewarning/ui/PickerSearchTest.kt, run against the
 * TypeScript port in src/components/pickerSearch.ts.
 *
 * Run: tsx tests/picker-search.test.ts
 */
import assert from 'node:assert/strict';
import { CONTAINS, NO_MATCH, PREFIX, PickerIndex, WORD_PREFIX, contextSnippet, filterItems, rank, type SearchKind } from '../src/components/pickerSearch';

const search = (items: string[], query: string, kind: SearchKind = 'TEXT'): string[] => filterItems(items, query, kind, (s) => s);

const tests: [string, () => void][] = [];
const test = (name: string, fn: () => void) => tests.push([name, fn]);

test('prefixBeatsWordPrefixBeatsContains', () => {
  const items = ['вул. Пушкіна', 'вул. Старошевченківська', 'вул. Нова Шевченка', 'вул. Шевченка'];
  assert.deepEqual(search(items, 'ш'), ['вул. Шевченка', 'вул. Нова Шевченка', 'вул. Пушкіна', 'вул. Старошевченківська']);
});

test('rankConstantsAreOrdered', () => {
  assert.equal(rank('ш', 'Шевченка'), PREFIX);
  assert.equal(rank('ш', 'Нова Шевченка'), WORD_PREFIX);
  assert.equal(rank('ш', 'Пушкіна'), CONTAINS);
  assert.equal(rank('ш', 'Київська'), NO_MATCH);
});

test('emptyQueryKeepsEveryItemInOriginalOrder', () => {
  const items = ['Б', 'А', 'В'];
  assert.deepEqual(search(items, ''), items);
  assert.deepEqual(search(items, '   '), items);
});

test('noMatchGivesEmptyList', () => {
  assert.equal(search(['вул. Шевченка', 'вул. Київська'], 'яяя').length, 0);
});

test('originalOrderIsKeptInsideOneRank', () => {
  const items = ['вул. Шевченка 2', 'вул. Шевченка 1', 'вул. Шевченка'];
  assert.deepEqual(search(items, 'шев'), items);
});

test('streetTypePrefixIsOptionalOnBothSides', () => {
  const items = ['вул. Шевченка', 'пров. Шевченка', 'м. Житомир', 'с. Березина'];
  assert.deepEqual(search(items, 'шевч'), ['вул. Шевченка', 'пров. Шевченка']);
  assert.deepEqual(search(['вул. Шевченка', 'пров. Шевченка'].reverse(), 'пров шевч'), ['пров. Шевченка', 'вул. Шевченка']);
  assert.deepEqual(search(items, 'вул шевч'), ['вул. Шевченка', 'пров. Шевченка']);
  assert.deepEqual(search(items, 'вул. шевч'), ['вул. Шевченка', 'пров. Шевченка']);
  assert.deepEqual(search(['вулиця Шевченка'], 'Шевч'), ['вулиця Шевченка']);
  assert.deepEqual(search(items, 'жито'), ['м. Житомир']);
  assert.deepEqual(search(items, 'берез'), ['с. Березина']);
  assert.deepEqual(search(items, 'с берез'), ['с. Березина']);
});

test('caseDoesNotMatter', () => {
  assert.deepEqual(search(['Шевченка', 'Київська'], 'ШЕВ'), ['Шевченка']);
  assert.deepEqual(search(['ШЕВЧЕНКА'], 'шев'), ['ШЕВЧЕНКА']);
});

test('typeWordAloneStillMatchesByFullKey', () => {
  assert.deepEqual(search(['вул. Шевченка', 'пров. Шевченка'], 'вул'), ['вул. Шевченка']);
});

test('everyApostropheVariantMatchesEveryOther', () => {
  const variants = ["'", '’', 'ʼ', '`', '´', '‘'];
  for (const inLabel of variants) {
    const label = `вул. Пр${inLabel}ятна`;
    for (const typed of variants) {
      assert.deepEqual(search([label], `пр${typed}я`), [label], `label ${inLabel} typed ${typed}`);
    }
    assert.deepEqual(search([label], 'пря'), [label]);
  }
  assert.deepEqual(search(["вул. Пр'ятна"], 'прʼ'), ["вул. Пр'ятна"]);
});

test('apostropheEntityInLabelIsDecoded', () => {
  assert.deepEqual(search(['с. Кам&#039;янка'], "кам'я"), ['с. Кам&#039;янка']);
});

test('latinLookAlikesMatchCyrillicLabels', () => {
  assert.deepEqual(search(['вул. Хрещатик', 'вул. Київська'], 'Xpe'), ['вул. Хрещатик']);
  assert.deepEqual(search(['вул. Садова', 'вул. Київська'], 'Cад'), ['вул. Садова']);
});

test('cyrillicLookAlikesMatchLatinLabels', () => {
  assert.deepEqual(search(['Pocket', 'Other'], 'Ро'), ['Pocket']);
});

test('diacriticsAreIgnored', () => {
  assert.deepEqual(search(['вул. Київська', 'вул. Шевченка'], 'киів'), ['вул. Київська']);
  assert.deepEqual(search(['вул. Київська', 'вул. Шевченка'], 'київ'), ['вул. Київська']);
  assert.deepEqual(search(['вул. Військова'], 'віи'), ['вул. Військова']);
  assert.deepEqual(search(['Café', 'Other'], 'cafe'), ['Café']);
});

test('houseLatinAMatchesCyrillicA', () => {
  const houses = ['15', '16', '16А', '16Б', '160'];
  assert.deepEqual(search(houses, '16a', 'HOUSE'), ['16А']);
  assert.deepEqual(search(houses, '16А', 'HOUSE'), ['16А']);
  assert.deepEqual(search(houses, '16б', 'HOUSE'), ['16Б']);
});

test('houseHyphenSpaceAndPrefixWordsAreIgnored', () => {
  const houses = ['34-А', '34', '340'];
  assert.deepEqual(search(houses, '34a', 'HOUSE').filter((h) => h.includes('А')), ['34-А']);
  assert.deepEqual(search(['34-А'], '34 а', 'HOUSE'), ['34-А']);
  assert.deepEqual(search(['34-А'], 'буд. 34а', 'HOUSE'), ['34-А']);
  assert.deepEqual(search(['14/а', '15'], '14/a', 'HOUSE'), ['14/а']);
});

test('houseNumberListsShortestFirst', () => {
  const houses = ['1600', '16А', '216', '16', '161', '26'];
  assert.deepEqual(search(houses, '16', 'HOUSE'), ['16', '16А', '161', '1600', '216']);
});

test('textModeDoesNotStripDigitsOrLettersThatAreNotTypeWords', () => {
  assert.deepEqual(search(['вул. Садова', 'вул. Сонячна'], 'сад'), ['вул. Садова']);
  assert.deepEqual(search(['вул. Садова', 'вул. Сонячна'], 'сон'), ['вул. Сонячна']);
});

test('indexCanBeReusedForManyQueries', () => {
  const items = Array.from({ length: 966 }, (_, i) => `вул. Вулиця${i + 1}`);
  const index = new PickerIndex(items, 'TEXT', (s) => s);
  assert.equal(index.search('').length, 966);
  assert.equal(index.search('вулиця966').length, 1);
  assert.deepEqual(index.search('вулиця9').slice(0, 1), ['вул. Вулиця9']);
});

test('contextIsSearchedAfterLabelsAndShowsTheMatchedPiece', () => {
  // owner, 2026-11-17: «кафе» listed companies whose names do not have the word (it was in their PDF row)
  const items = [
    { name: 'КНП «ЛІЛ 1 рівня»', row: 'Дніпра 10/13, 12, 14 КНП "ЛІЛ 1 рівня" (ЗТП-64); КП ВУВКГ (ПНС Миру 31); кафе "Аква"; вул.Миру 18' },
    { name: 'кафе «Аква»', row: 'кафе "Аква"; вул.Миру 18' },
    { name: 'ТОВ «Ромашка»', row: 'вул. Миру 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, кафешка Світанок, 24' },
  ];
  const index = new PickerIndex(items, 'TEXT', (it) => it.name, (it) => it.row);
  const hits = index.searchHits('кафе');
  // the КНП row only names «кафе "Аква"», which is listed already
  assert.deepEqual(hits.map((h) => [h.item.name, h.snippet]), [
    ['кафе «Аква»', null],
    ['ТОВ «Ромашка»', 'кафешка Світанок'],
  ]);
  assert.deepEqual(index.searchHits('ЗТП-64').map((h) => [h.item.name, h.snippet]), [['КНП «ЛІЛ 1 рівня»', 'Дніпра 10/13, 12, 14 КНП "ЛІЛ 1 рівня" (ЗТП-64)']]);
  assert.equal(contextSnippet('вул. Миру 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, Кафе "Ні пуху, ні пера", 24', 'пера'), 'Кафе "Ні пуху, ні пера"', 'a comma inside quotes does not cut');
  assert.equal(
    contextSnippet('вул. Миру 1, 2, 3, 4, 5, 6, ТОВ «Татнєфть-АЗС Україна, ПП «Лякун», Кафе «Ні пуху, ні пера», База «Владтранс»', 'кафе'),
    'Кафе «Ні пуху, ні пера»',
    'unbalanced quotes of the PDF'
  );
  assert.deepEqual(index.searchHits('').map((h) => h.snippet), [null, null, null]);
  assert.equal(contextSnippet('a'.repeat(100), 'b'), 'a'.repeat(69) + '…', 'no piece matches: the clipped start');
});

let failed = 0;
test('quotesOfEveryKindCountAsSpaces', () => {
  // owner, 2026-11-17: ТОВ "ГЛОБИНСЬКИЙ БІОЕНЕРГЕТИЧНИЙ КОМПЛЕКС was not found
  const items = ['ТОВ «ГЛОБИНСЬКИЙ БІОЕНЕРГЕТИЧНИЙ КОМПЛЕКС» · 2.1', "КП «Полтавський м'ясокомбінат» · 1.1"];
  for (const q of ['ТОВ "ГЛОБИНСЬКИЙ БІОЕНЕРГЕТИЧНИЙ КОМПЛЕКС', 'ТОВ ГЛОБИНСЬКИЙ', 'тов «глобинський', 'ТОВ „Глобинський“']) {
    assert.deepEqual(search(items, q), [items[0]], q);
  }
  assert.deepEqual(search(items, 'КП "Полтавський мясокомбінат'), [items[1]]);
  assert.deepEqual(search(['Школа № 27 · Кременчук', 'Школа № 2 · Кременчук'], 'школа 27'), ['Школа № 27 · Кременчук']);
});

for (const [name, fn] of tests) {
  try {
    fn();
    console.log(`PASS ${name}`);
  } catch (e) {
    failed++;
    console.error(`FAIL ${name}`);
    console.error(e instanceof Error ? e.message : e);
  }
}
if (failed > 0) {
  console.error(`${failed} picker search test(s) failed`);
  process.exit(1);
}
console.log(`All ${tests.length} picker search tests passed`);
