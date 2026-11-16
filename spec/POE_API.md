# POE_API

How «Світло в Полтаві» reads Полтаваобленерго (POE): the queue schedule, the address directory, the per-house status (queue, emergency, repair works) and the per-branch outage registry, and how the answers become outages. This file replaces `ZTOE` + `POWERON_API.md` for the Poltava app; those two files describe the inherited Zhytomyr data layer until it is removed in P2.

Pure reference implementation: Kotlin `android/app/src/main/java/ua/blackout/prewarning/core/PoeMapper.kt`, TypeScript `src/core/poeMapper.ts`. Golden cases: `spec/vectors/poe_api.json`. Branch table: `spec/branches.json`. Live samples: `spec/fixtures/poe/` (2026-11-16). Constants: `spec/config.json` (`poe`).

Facts below were probed live on 2026-11-16. The endpoints are public (no login) but internal to the POE website (PHP proxies to `poeREST`); treat everything that changes with time as an observation, not a contract.

## 1. Transport

| Rule | Value |
|---|---|
| Base | `https://www.poe.pl.ua/customs/` (nginx, no Cloudflare) |
| Method | `POST`, `Content-Type: application/x-www-form-urlencoded; charset=UTF-8`, **one** form field whose value is a JSON string (E6 is a `GET`) |
| Encoding | UTF-8 answers; send `Accept-Encoding: gzip` (the schedule is 184 KB raw, 14 KB gzipped) |
| Caching | no `ETag`, no `Last-Modified`: hash the body to skip re-parsing |
| Status codes | errors come back as **HTTP 200** with a JSON error body (`{"title":"Bad Request","status":400,...}`) or an empty body; never trust the status code alone |
| Timeouts | connect 8 000 ms, read 8 000 ms (registry: read 15 000 ms) |
| User-Agent | free text, for example `Mozilla/5.0 (Android; PoltavaBlackoutPreWarning)` |

## 2. Endpoints

| # | Endpoint | Form field and JSON | Answer | Used for |
|---|---|---|---|---|
| E1 | `newgpv-info.php` | `seldate={"date_in":"DD-MM-YYYY"}` | HTML fragment, section 3; **empty body = not published yet** | queue schedule, today and tomorrow |
| E2 | `unloading-info.php` | `seldate={"date_in":"DD-MM-YYYY"}` | JSON array of active measures, section 7 | ГАВ / ГОП banner (site notice) |
| E3 | `search-disconnection-cabinet.php` | `disconn={"operation_type":"city"\|"street"\|"building","filial_id":"<cabinetId>","city_id":"<id or empty>","street_id":"<id or empty>"}` | `[{"instance_id":N,"instance_name":"..."}]` | address directory, section 4 |
| E4 | `disconnectinforesult-cabinet.php` | `disconn={"cityid":"<city id>","streerid":"<street id>","house":"<house name>"}` | one-element JSON array, section 5 | queue, emergency, repair works of one house |
| E5 | `disconnection-gavapi.php` | `disconngav={"filialid":"<registryId>","date_in":"DD-MM-YYYY"}` | `[{"fil_code":N,"out_text":"<tr>...</tr>"}]`, section 6 | outages of one branch: fallback and the «Ремонти й пошкодження поруч» card |
| E6 | `dynamicgpv-info.php` (GET) | none | same HTML as E1 for today | not used |

Traps:

1. **Date format** is `DD-MM-YYYY` with hyphens. `DD.MM.YYYY` returns the JSON 400 body with HTTP 200.
2. **`streerid`** in E4 is POE's own misspelling and must be sent as is.
3. **Two branch id spaces** (`spec/branches.json`): E3 takes `cabinetId` (102..131), E5 takes `registryId` (2..31). Today `cabinetId = registryId + 100`; read both columns, never compute one from the other.
4. `city_id` and `street_id` are **global** (not per branch). 86 settlements appear under several branches with the same id and the same streets (м. Полтава under 9 branches). The branch only filters the settlement list of E3.
5. E4 matches the house by its **name** (`instance_name` from E3), not by `instance_id`, which is just a row number.
6. Street and house names carry trailing spaces, old names in brackets and spelling variants (`вул. Соборності `, `30 /12`, `30-12`, `30/12`): `StreetKey` / `HouseKey` (`ADDRESS_KEY.md`) apply.

## 3. Schedule HTML (E1)

```html
<table class="gpv-table"> ... <tbody>
  <tr><td class="gpv-q">1.1</td>
      <td class="gpv-c gpv-s3 gpv-h gpv-past" title="1.1: 00:00–00:30 — Час, необхідний для перемикань. Електроенергії може не бути"></td>
      <td class="gpv-c gpv-s1 gpv-past" title="1.1: 00:30–01:00 — «Увімкнено», електроенергія наявна"></td> ... 48 cells
```

| Class | Cell state |
|---|---|
| `gpv-s1` | `ON` («Увімкнено», power on) |
| `gpv-s2` | `OFF` («Вимкнено», power off) |
| `gpv-s3` | `SWITCHING` («Час, необхідний для перемикань. Електроенергії може не бути») |

- 12 rows (`td.gpv-q` = queue `1.1`..`6.2`), 48 `td.gpv-c` each, cell `i` = `[i*30, i*30+30)` minutes. Other classes (`gpv-h`, `gpv-past`, `gpv-now*`) are decoration. A row with any other cell count, an unknown queue, or a cell without `gpv-s1/2/3` makes the whole table invalid (site format changed).
- The `title` attribute repeats the queue, the cell time and the state text; parsers may use it as a cross-check.
- `.gpv-periods li` lists the `OFF` runs only (`1.1 — 04:00–07:00, 10:00–13:00, ...`); the `SWITCHING` half-hour after each run is not listed.
- The header text names the date (`16 листопада 2026 року`), the queue volume per time range (`з 00:00 по 22:00 ... в обсязі 3 черги`) and the stamp `Оновлено: 15 листопада 2026 22:46`.
- Validation: the date in the header must equal the requested date, otherwise the answer is invalid. An **empty body** means "not published" (tomorrow before POE publishes it). A non-HTML body (JSON error) means "site error", never "no outages".
- Observed pattern: a `SWITCHING` cell follows the end of every `OFF` run (1.1: `OFF` 04:00–07:00, `SWITCHING` 07:00–07:30). The page note says power is switched on within that last half-hour. How the engine treats it: `OUTAGE_ENGINE.md` section 3.5.

Parser: pure text scanning in the core (`PoeSchedule.parseDay`, Kotlin `core/PoeSchedule.kt`, TypeScript `src/core/poeSchedule.ts`), no HTML library, so the Swift port can follow it rule for rule. Results: `PUBLISHED` (12 queues × 48 cells, stamp), `NOT_PUBLISHED` (empty body), `INVALID` with a reason (`error_body`, `no_date`, `date_mismatch`, `no_table`, `bad_row`, `missing_queue`). A page without a table that says the schedule is not applied (`не застосов...`, wording not yet seen live) is `PUBLISHED` with every cell on. Golden cases: `spec/vectors/poe_schedule.json` (the live page of 2026-11-16 and constructed edge cases).

## 4. Address directory (E3)

`operation_type`:

| Value | Needs | Returns |
|---|---|---|
| `city` | `filial_id` | settlements of the branch: `місто Полтава`, `село Сухорабівка`, `селище ...`; junk rows such as `село _` exist and are dropped |
| `street` | `filial_id`, `city_id` | streets: `вул. Соборності `, `автодорога 326 км`, ... |
| `building` | `filial_id`, `city_id`, `street_id` | houses: `1`, `11/13`, `30 /12` (names; `instance_id` is a row number) |

First crawl (`scripts/crawl_poe_directory.py`, 2026-11-16, 0 failed requests): 28 branches, 1 777 unique settlements, 20 395 streets (`docs/research/directory/`). The app bundles that snapshot and refreshes it as described in the plan, section 4.4.

**Subscription address** (`SUBSCRIPTIONS.md`, no model change): `remSlug` = branch `slug`, `settlementId` = POE `city_id` (as text), `streetId` = POE `street_id`, `streetName` = the E3 street name, `house` = the E3 house name, `text` = the human-readable line.

## 5. Per-house status (E4)

```json
[{"fn_accident_message":"зареєстрована аварійна перерва в електропостачанні 16.11.2026 р. з 08 годин(и)  59  хвилин(и). Очікуваний час закінчення перерви в електропостачанні: 16.11.2026 р. о 15  годин(и)  59 хвилин(и).",
  "message_type":3, "accident_str":"16.11.2026 08:59", "accident_id":3462256, "accident_date":"16.11.2026 15:32",
  "accid_msg_logid":null,
  "gav_message":"Заживлено від ПЛ-0,4 кВ КТП-476 Л-3 с.Зуївці та залучено до АЧР, СГАВ, САВН.",
  "gp_qnum_1":"", "gp_qnum_2":"",
  "planned_message":"- запланована перерва в електропостачанні для проведення ремонтних робіт 20.11.2026 р. з 08-ї до 20-ї години.<br><br>- ..."}]
```

| Field | Meaning |
|---|---|
| `message_type` | `0` nothing registered (`не зареєстровано перерв`); `2` repair works now (`проводяться планові ремонтні роботи`); `3` emergency now (`зареєстрована аварійна перерва`) = what online.poltava.ua calls **«пошкодження»**; `4` seen 2026-11-16 18:06 = off **because of the hourly schedule** (`... внаслідок застосування графіку погодинних відключень (ГПВ) ... з 16 годин(и) 00 хвилин(и) ... о 19 годин(и) 30 хвилин(и)`: queue 1.1's block 16:00–19:00 plus its switching half-hour), a mirror of E1, not an emergency |
| `accident_str` | start, `DD.MM.YYYY HH:mm`, Kyiv wall clock (no offset to drop) |
| `accident_id` | POE's stable id of the outage |
| `fn_accident_message` | free text with the estimated end: `... DD.MM.YYYY р. о HH годин(и) MM хвилин(и)` |
| `gp_qnum_1`, `gp_qnum_2` | queue `4` + `2` = `4.2`; **both empty = the house is in no queue** (emergencies only) |
| `gav_message` | feeder and the schedules the house belongs to (`ГАВ (черга N)`, `АЧР`, `СГАВ`, `САВН`, `ГПВ (черга x-y)`); shown as an info line, not parsed by the core |
| `planned_message` | future repair works, `<br>`-separated: `... DD.MM.YYYY р. з HH-ї до HH-ї години.` |
| `accident_date` | server time of the answer; ignored |

The mapping is pure (`PoeMapper`), section 8.

## 6. Branch registry (E5)

`out_text` is one table row:

```html
<tr><td>16.11.2026 08:59:00</td><td>16.11.2026 15:59</td><td><b>с.Зуївці</b><br><b>вул.Дружби</b> (б. 1, 9, 15, 17, 26, 28),<br><b>вул.Зелена</b> (б. 2, 13, 23, 27),<br><b>вул.Молодіжна</b> (б. 28)<br></td><td>Аварійна перерва</td><tr>
```

Cells: start, end, places, reason. Places: groups separated by an empty line (`<br><br>`); the first line of a group is the settlement (`<b>м.Полтава</b>`); each further line is either a street with houses (`<b>вул.X</b> (б. 1, 1а, 5),`) or free text (`Полтава, вул. Зінківська, 52,`).

Reasons seen on 2026-11-16 (28 branches, 1 378 rows, 1.6 MB raw):

| Reason | Rows | Class |
|---|---|---|
| `Аварійна перерва` | 5 | `EMERGENCY` («пошкодження») |
| `Планова перерва` | 39 | `REPAIR` |
| `Застосування графіків обмеження споживачів (ГПВ 3-1)` | 1 311 | `MIRROR` of the queue schedule: ignored, like PowerOn `switchSubReason = 2` |
| *(empty)* | 23 | `REPAIR` (online.poltava.ua shows them as planned) |

**House lists are incomplete.** Зуївці 2026-11-16: the registry lists вул. Дружби 1, 9, 15, 17, 26, 28, but E4 reports the same emergency for вул. Дружби 3 (E4 resolves the house through its feeder). Therefore:

- E4 is the **primary** emergency and repair source for an address;
- E5 is a **fallback** (only while E4 is unavailable) and the source of the display-only «Ремонти й пошкодження поруч» card;
- an E5 row whose street matches but whose house list does not contain the house is a *possible* outage on the street, never a confirmed one and never "no outage" (`registryMatch`, section 8).

## 7. Active measures (E2)

```json
[{"unloaddata":"16-11-2026","beginhour":8,"beginminute":54,"endhour":23,"endminute":59,"volume":40,
  "unloadingtypeid":1,"unloadingtypename":"ГАВ","unloadingreasonid":2,"unloadingreasonname":"за розпорядженням НЕК «Укренерго»",
  "note":null,"createddate":"16-11-2026 08:59","unloading_queue_number":0,"import_percent":"0"}, ...]
```

Each item becomes one site notice line (`SITE_STATE.md`, notice card): `unloadingtypename` (`ГАВ`, `ГОП`, `ГПВ`, `СГАВ`), the time range `beginhour:beginminute`–`endhour:endminute` and `unloadingreasonname`. An empty array means no measures. Parsing is data layer (P2).

## 8. Mapping (`PoeMapper`, pure)

All times are `LocalDateTime` in Kyiv wall-clock (`OUTAGE_ENGINE.md` section 1). Text form `yyyy-MM-ddTHH:mm`.

### 8.1 `parseTime(raw) -> LocalDateTime?`

Match `^\s*(\d{1,2})\.(\d{1,2})\.(\d{4})\s+(\d{1,2}):(\d{2})(?::\d{2})?` at the start. Build the date and time; an impossible date or time (31.11, 29.02 of a non-leap year, hour 24, minute 60) gives null. Seconds are ignored. No match: null.

### 8.2 `parseEta(message) -> LocalDateTime?`

The estimated end inside `fn_accident_message`. Search the text after the word `закінчення` (the whole text when the word is missing) for the **first** match of

`(\d{1,2})\.(\d{1,2})\.(\d{4})\s*р\.?\s*о\s*(\d{1,2})\s*годин\S*\s*(\d{1,2})\s*хвилин`

(spaces between the parts vary, `годин(и)` may be written `годин`, `години`, `годину`). Hour `24` with minute `0` means `00:00` of the next day; any other impossible value gives null. No match: null.

### 8.3 `parsePlannedList(text) -> [{start, end}]`

Split `planned_message` on `<br>` (`<br>`, `<br/>`, `<br />`, any case). For each part, the first match of

`(\d{1,2})\.(\d{1,2})\.(\d{4})\s*р\.?\s*з\s*(\d{1,2})(?:[:.](\d{2}))?(?:-?ї)?\s*до\s*(\d{1,2})(?:[:.](\d{2}))?(?:-?ї)?\s*годин`

gives `start` = date + first time, `end` = same date + second time (minutes default to 0; `24` or `24:00` = next day `00:00`). Keep pairs with `end > start` and valid times. Remove exact duplicates (POE repeats entries). Keep text order.

### 8.4 `parseQueue(q1, q2) -> string?`

Trim both. `q1` in `1..6` and `q2` in `1..2` (digits only) gives `"q1.q2"`; anything else (both empty included) gives null.

### 8.5 `addressStatus(result, today) -> AddressStatus`

`result` is the first element of the E4 array (a map). Output: `{ messageType, queue, emergency?, repairs[], scheduleMirror, unparsed }`.

1. `messageType` = `message_type` as an integer (missing or not a number: `-1`). `queue = parseQueue(gp_qnum_1, gp_qnum_2)`.
2. `start = parseTime(accident_str)`; `eta = parseEta(fn_accident_message)`, kept only if `eta > start`.
3. By `messageType`:
   - `0`: no current outage.
   - `2` (repair works now): if `start` and `eta` are both known, one repair `{id = "repair_" + start, start, end = eta, label = "Планові роботи"}`; otherwise `unparsed = true`.
   - any other value except `0` and `3` whose `fn_accident_message` names the hourly schedule (lower-cased text contains `гпв` or `погодинн`, as type `4` does): `scheduleMirror = true`, no emergency. The outage is already on the drum from E1; announcing it as an emergency would send a false «аварійне» alert for every scheduled block.
   - `3`, and any other value except `0` that is not a schedule mirror (an unknown type is treated as an emergency, the safe side; for example a cut by ГАВ / СГАВ): if `start` is known, `emergency = EmergencyRecord(id, start, estimatedEnd = eta, label)` with `id = "poe_" + accident_id` when `accident_id` is a positive integer, else `"poe_" + start`; `label = "Аварійна перерва"` for type 3, `"Перерва в електропостачанні"` for other types. If `start` is null: `unparsed = true`.
4. `planned_message`: every pair of `parsePlannedList` with `start < (today + 2 days) 00:00` becomes a repair `{id = "repair_" + start, start, end, label = "Планові роботи"}` (works dated beyond tomorrow are dropped, as in `POWERON_API.md` 5.2). Repairs with the same `id` merge (the later `end` wins). `repairs` is sorted by `start`.
5. `unparsed = true` makes the adapter report the fetch as `Unavailable("unparsed")`, never as "no outage" (section 9).

### 8.6 `classifyRegistryReason(reason) -> EMERGENCY | REPAIR | MIRROR`

Trim and lower-case. Contains `авар` → `EMERGENCY`. Else contains `гпв` or `графік` → `MIRROR`. Else (empty included) → `REPAIR`.

### 8.7 `parseRegistryRow(outText) -> RegistryRow?`

Take the contents of the `<td>` cells in order. Fewer than 4 cells, or `parseTime(cell 0)` null: null. `end = parseTime(cell 1)` (null allowed: open-ended). `reason` = cell 3 without tags, entities decoded, trimmed. `kind = classifyRegistryReason(reason)`. `places = parsePlaces(cell 2)`. `id = "poe_reg_" + start` (text form).

### 8.8 `parsePlaces(html) -> [{settlement, streets: [{street, houses[]}], freeText[]}]`

1. Decode entities (`TextNorm.decodeEntities`). Split into groups on two `<br>` with only whitespace or a comma between them.
2. In each group split lines on `<br>`; drop blank lines. The first line, tags removed and trimmed, is `settlement`.
3. Every further line, trimmed of whitespace and a trailing comma:
   - `<b>NAME</b>` optionally followed by `(б. LIST)`: a street `NAME` (trimmed) with `houses` = `LIST` split on `,`, each trimmed, empty ones dropped (no list: empty houses = the whole street);
   - anything else, tags removed: free text. A free text of the form `A, B, C` whose last part contains a digit is also read as street `B` with houses `[C]` (and `A, B` as street `B` with no houses); the original line stays in `freeText`.
4. A group with no settlement line is dropped.

### 8.9 `settlementKey(name)` and `registryMatch(places, settlement, street, house) -> CONFIRMED | STREET | NONE`

`settlementKey`: decode entities, lower-case, remove a leading type word (`місто`, `село`, `селище`, `смт`, `м.`, `с.`, `смт.`, `сщ.`), remove a bracketed tail (`(Гребінківська міська рада/ТГ)`), collapse whitespace, then `StreetKey.of` of the rest (folds apostrophes, case and Latin look-alikes).

Street names are compared with `streetKey(name)` = insert a space after a leading type abbreviation glued to the name (`вул.Дружби` → `вул. Дружби`), remove a bracketed tail (old name), then `StreetKey.of`.

`registryMatch` looks at every group whose `settlementKey` equals the address's, and every street (parsed or read from free text) whose `streetKey` equals the address's street:

- some such street lists the house (`HouseKey.listContains` over the joined list) → `CONFIRMED`;
- else some such street exists (with or without a house list) → `STREET`;
- else → `NONE`.

## 9. Failure semantics

Every fetch yields exactly one of `Confirmed(...)` or `Unavailable(reason)`, as in `POWERON_API.md` section 8:

| Source | Confirmed | Unavailable |
|---|---|---|
| E1 | valid table for the requested date, or "not published" (empty body, only for tomorrow) | network error, non-HTML body, invalid table, header date mismatch |
| E4 | a parsed status with `unparsed = false` (also `message_type 0`) | network error, not a JSON array, empty array, `unparsed = true` |
| E5 | a JSON array (empty = no outages in the branch) | anything else |

`Unavailable` never becomes "no outage": the ledger keeps its state (no false "power is back"), and the last confirmed repairs stay.

## 10. Request budget

Per refresh (default every 30 min): E1 today + E1 tomorrow (gzip about 14 KB each), E2 (under 1 KB), E4 once per address (about 1.5 KB, cached 60 s per address), E5 once per branch of the shown address for the nearby card (about 50 KB gzipped). Oblast-wide crawls (E3 over all branches) run only in CI scripts, never on a device.

## Vectors

`spec/vectors/poe_schedule.json`: the schedule parser (section 3). `spec/vectors/poe_api.json`: `times`, `eta`, `plannedList`, `queue`, `addressStatus` (the four live E4 samples of 2026-11-16, types 0, 2, 3 and 4, plus edge cases), `registryReason`, `registryRows` (live E5 rows), `registryMatch` (incl. the Зуївці house that the registry omits). `spec/vectors/outage_engine_poe.json`: the switching half-hour (`OUTAGE_ENGINE.md` 3.5).

Runners: Kotlin `PoeVectorsTest.kt` and TypeScript `tests/spec-vectors.test.ts` run all three files; the clients (`data/poe/PoeClient.kt`, `src/services/poeClient.ts`) are tested against the recorded answers in `spec/fixtures/poe/` (`PoeClientTest.kt`, `tests/poe-client.test.ts`); `scripts/poe-live-probe.ts` reads the live site (daily in `.github/workflows/poe-data.yml`); the iOS XCTest target starts running them in milestone I1 (it loads vector files by name, so the new files do not affect it before that).
