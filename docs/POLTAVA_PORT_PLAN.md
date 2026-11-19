# Poltava port plan: "Світло в Житомирі" 1.4.0 for Полтаваобленерго

| | |
|---|---|
| Written | 2026-11-16 |
| Status | **Approved 2026-11-16** (owner decisions D1–D9 in section 9). Research done (live probes of both sites on 2026-11-16, saved responses in `spec/fixtures/poe/`, address directory crawl in `docs/research/directory/`). **P0 done 2026-11-16** on branch `feat/p0-seed-rebrand`: upstream history merged; «Світло в Полтаві», application id `ua.blackout.prewarning.poltava` with its own signing key, version 1.0.0, Facebook link, repository links, roulette removed from Android and web; `npm test` and 97 Android unit tests green locally, debug APK checked with aapt2/apksigner. Not yet checked: the GitHub Actions run (nothing pushed) and installing next to the Zhytomyr app on a phone. **P1 done 2026-11-16** on branch `feat/p1-poe-spec`: `spec/POE_API.md`, `spec/branches.json`, switching half-hour in the engine and drum spec, vectors `poe_api.json` / `outage_engine_poe.json`, and (moved forward from P2 so no vector is ever red or skipped) the pure core `PoeMapper` + switching support in Kotlin and TypeScript. **P2 done 2026-11-16** on branch `feat/p2-poe-data`: schedule parser in the core (`PoeSchedule`), POE clients for Android (`data/poe/`) and the web (`src/services/poeClient.ts`, dev proxy `/proxy-poe`), directory snapshot `poe_directory.json` with synced copies, live probe script and `.github/workflows/poe-data.yml` (daily probe, weekly crawl). Found live: `message_type 4` = off by the hourly schedule, now a schedule mirror and never an emergency. Moved to P3: deleting the Zhytomyr data layer. **P3 done 2026-11-16** on branch `feat/p3-poe-wiring`: Android and the web simulator run on POE data. `OutageRepository` (both platforms) refreshes the POE tables and the per-house status of every address, writes the queue POE reports back into the subscriptions, and feeds the switching windows to the engine; the address picker and the address re-check use `PoeAddressLookup` (bundled directory, houses live); the Settings site check reads today's POE table; `ztoe`/PowerOn code, the ztoe/PowerOn dev proxies, its tests, the PowerOn id cache and Jsoup are removed (the iOS app keeps its copy until I1–I2). Not in P3 (moved to P4 with the UI): drawing the switching cells and the no-queue card, the ГАВ/ГОП banner, the nearby-outages card, and the registry (E5) fallback, which can only add confirmed houses because its lists are incomplete. **P4 done 2026-11-16** on branch `feat/p4-poe-ui` (Android and web): switching cells on the drum and the widget bitmaps from one classification (`DrumCells`, signature tested on both sides) and «світло повернеться HH:MM–HH:MM» in the hero; «Ремонти й пошкодження поруч» above the hero, only rows on the address's own street (`PoeMapper.nearbyOutages`, `POE_API.md` 8.10, 6 vectors); the E2 measures card above the links; switching cells full height (owner feedback 2026-11-16); the `gav_message` line; the no-queue card title; picker labels, oblast-wide settlement search and the three scoped refresh buttons; POE texts (site states, About, disclaimer, site link); the queue help text approved by the owner; the owner's logo as launcher icon and About logo (`scripts/build_app_icons.py`). Added on the owner's request: `poe_queues.json`, an address and company -> queue catalogue from POE's hourly-schedule PDF, rebuilt daily in CI only when the PDF changes (`POE_API.md` 8.11), for the houses whose per-house status says "several connections" and gives no queue. The apps read it (2026-11-17): for such a house the picker offers the catalogue's queues, a refresh never clears a chosen queue, a company search adds a queue-only entry named after the company, and a settlement without streets or a street without house numbers (с. Минівка, с. Головач вул. Кринична) disables the lower picker and adds the place's queue as a queue-only entry. Not done in P4: the registry (E5) fallback for a failed per-house status (the card shows the registry, but alerts still come from E4 only), and the side-by-side comparison with the Zhytomyr 1.4.0 screenshots on a phone (P5). Next is P5. |
| Base | `IgorZaharov/Android-ZTBlackoutPreWarning` at `c5573b9` (Android 1.4.0, iOS M7, `spec/` with golden vectors) |
| Order | Android first (P0–P6), iOS second (I0–I5) |
| Goal | The same app (screens, widgets, search, multi-address, alerts, emergencies), fed by Полтаваобленерго (POE) data instead of ZTOE + PowerOn |

---

## 1. Summary

- **Keep:** the whole 1.4.0 app. That means the pure `core/` (OutageEngine, EmergencyLedger, Subscriptions, AddressKeys), alarms, notifications, the Glance and WidgetKit widgets, all screens, the drum, the time-of-day palette and donations.
- **Replace:** the data layer only. That is `ZtoeParser`, `ZtoeAddressLookup`, `ZtoeStaticDirectory`, `PowerOnClient`, `PowerOnMapper` and the REM table.
- **Main source: the official site `www.poe.pl.ua`.** It has public endpoints (no login) for all four things the app needs:
  1. the queue schedule (12 queues × 48 half-hour cells),
  2. the address directory (branch → settlement → street → house),
  3. a per-house status (queue + emergency/repair now + future repairs),
  4. a per-branch outage registry.
- **`online.poltava.ua` ("Полтава Цифрова") is not used as a data source.** It is a third-party aggregator that scrapes POE ("Дані: Полтаваобленерго (офіційний сайт)"; `queueSource: "poe"`), sits behind Cloudflare, rate-limits (`429`) and can change at any time. Its "пошкодження" label is POE's "Аварійна перерва" (section 3.4). We use it only as a cross-check while testing.
- **Three things are new compared with Zhytomyr:**
  - a third cell state, **switching** (`gpv-s3`, "Електроенергії може не бути");
  - addresses with **no queue** (emergency-only houses);
  - a **filial (branch)** step in place of the REM step.

---

## 2. What the existing app does with addresses (Zhytomyr, for reference)

| Step | Zhytomyr 1.4.0 | Code |
|---|---|---|
| Schedule | `GET ztoe.com.ua/unhooking-search.php`, Windows-1251 HTML, one leaf table per day, 48 cells per queue, red = off | `ZtoeParser.kt` |
| Address directory | POST form on the same page: `rem_id` → `naspunkt_id` → `vulica_id`; the `all=1` bulk page gives every house **with its queue** | `ZtoeAddressLookup.kt` (1 395 lines), `ZtoeStaticDirectory.kt`, `spec/rems.json` (19 REMs) |
| Emergencies + repairs | PowerOn JSON API per street id (`pw_accidents`, `pw_accident_planeds`); times are Kyiv wall-clock labelled `+00:00`; no history, so a local ledger is kept | `PowerOnClient.kt`, `core/PowerOnMapper.kt`, `spec/POWERON_API.md` |
| Duplicates | Streets and houses come in spelling variants, merged by `StreetKey` / `HouseKey` | `core/AddressKeys.kt`, `spec/ADDRESS_KEY.md` |
| Fail-safe | A failed fetch is never "no outage"; a site failure never clears the cached schedule | `SITE_STATE.md`, `EmergencyFetch.Unavailable` |

The Poltava port keeps the right-hand column's *rules* and replaces its *adapters*.

---

## 3. Data sources (probed live 2026-11-16)

### 3.1 POE endpoints

All endpoints are on `https://www.poe.pl.ua/customs/`. Requests are `POST` with `application/x-www-form-urlencoded` and one field whose value is a JSON string. Responses are UTF-8 and gzip works (the schedule is 184 KB raw, 14 KB gzipped). There is no ETag and no `Last-Modified`. nginx serves the site with no Cloudflare, and plain `curl` with a mobile User-Agent works.

| # | Endpoint | Body field | Returns | Use |
|---|---|---|---|---|
| E1 | `newgpv-info.php` | `seldate={"date_in":"DD-MM-YYYY"}` | HTML fragment (schedule for that day); **empty body = not published** (tomorrow before release). Proxies `poeREST/abon/site/turnoff/schedule/get/v2`. The wrong date format (`DD.MM.YYYY`) returns a JSON `400` with HTTP status 200. | Planned schedule, today + tomorrow |
| E2 | `unloading-info.php` | `seldate={"date_in":"DD-MM-YYYY"}` | JSON array of active measures: `unloadingtypename` (`ГАВ`, `ГОП`, `ГПВ`…), `beginhour/minute`, `endhour/minute`, `volume`, `unloading_queue_number`, `unloadingreasonname`, `createddate` | "ГАВ діє з 08:54" banner (the existing SiteNotice card) |
| E3 | `search-disconnection-cabinet.php` | `disconn={"operation_type":"city"\|"street"\|"building","filial_id":"1xx","city_id":"","street_id":""}` | `[{instance_id, instance_name}]` | Address picker |
| E4 | `disconnectinforesult-cabinet.php` | `disconn={"cityid":"…","streerid":"…","house":"<house name>"}` (the key `streerid` is POE's typo and must stay) | One-element array, see 3.3 | Queue of the house, emergency/repair now, future repairs |
| E5 | `disconnection-gavapi.php` | `disconngav={"filialid":"2..31","date_in":"DD-MM-YYYY"}` | `[{fil_code, out_text}]`; `out_text` is a `<tr>` with start, end, places (settlement / street / houses), reason | Fallback emergency source; cross-check |
| E6 | `dynamicgpv-info.php` (GET) | none | Same HTML as E1 for today | Optional; E1 is enough |

**Two branch id spaces.** This is the same trap as ZTOE `rem_id` vs PowerOn `otg.id`.
- The address cabinet (E3) uses `102…131`.
- The outage registry (E5) and the outages page use `2…31`.
- The rule is cabinet = registry + 100 for all 28 branches seen. Store both ids in `spec/branches.json` and never derive one from the other in code.

28 branches: Великокохнівська, Гадяцька, Глобинська, Горішньоплавнівська, Гребінківська, Диканська, Зіньківська, Карлівська, Кобеляцька, Козельщинська, Котелевська, Красногорівська дільниці; Кременчуцька об'єднана філія; Лохвицька, Лубенська (об'єднана), Машівська, Миргородська (об'єднана), Новосанжарська, Оржицька, Пирятинська дільниці; Полтавська дільниця РЕМ (`31`/`131`); Полтавська об'єднана філія (`23`/`123`); Решетилівська, Семенівська, Хорольська, Чорнухинська, Чутівська, Шишацька.

### 3.2 Schedule HTML (E1)

```html
<table class="gpv-table"> … <tbody>
  <tr><td class="gpv-q">1.1</td>
      <td class="gpv-c gpv-s3 gpv-h gpv-past" title="1.1: 00:00–00:30 — Час, необхідний для перемикань. Електроенергії може не бути"></td>
      <td class="gpv-c gpv-s1 gpv-past" title="1.1: 00:30–01:00 — «Увімкнено», електроенергія наявна"></td> … 48 cells
```

- 12 rows, 48 `td.gpv-c` each. The state is in the class:
  - `gpv-s1` = on,
  - `gpv-s2` = off,
  - `gpv-s3` = switching ("may be off").
- `gpv-past`, `gpv-h` and `gpv-now*` are decoration and must be ignored. The `title` holds the same data in text form and serves as a second check.
- `.gpv-periods li` lists the off blocks: `1.1 — 04:00–07:00, 10:00–13:00, …`. These are the s2 cells only; the switching half-hour after each block is not included.
- The header text holds the date (`16 листопада 2026 року`), the queue volume per time range (`з 00:00 по 22:00 … в обсязі 3 черги`) and `Оновлено: 15 листопада 2026 22:46`.
- Validation:
  - the parser checks that the date in the header equals the requested date;
  - an empty body means "not published", not "no outages";
  - the text "графік … не застосовувати" means "published, no outages".
- Observed pattern: an s3 cell follows the end of every s2 block (1.1: s2 04:00–07:00, then s3 07:00–07:30). The page's own note says the switch-on happens inside a half-hour window. online.poltava.ua folds s3 into the off interval (1.1 shows `04:00–07:30`).

### 3.3 Per-house status (E4): the key endpoint

```json
[{"fn_accident_message":"зареєстрована аварійна перерва в електропостачанні 16.11.2026 р. з 08 годин(и)  59  хвилин(и). Очікуваний час закінчення перерви в електропостачанні: 16.11.2026 р. о 15  годин(и)  59 хвилин(и).",
  "message_type":3, "accident_str":"16.11.2026 08:59", "accident_id":3462256, "accident_date":"16.11.2026 15:32",
  "gav_message":"Заживлено від ПЛ-0,4 кВ КТП-476 Л-3 с.Зуївці та залучено до АЧР, СГАВ, САВН.",
  "gp_qnum_1":"", "gp_qnum_2":"",
  "planned_message":"- запланована перерва в електропостачанні для проведення ремонтних робіт 20.11.2026 р. з 08-ї до 20-ї години.<br><br>- …"}]
```

| Field | Meaning | Mapping |
|---|---|---|
| `message_type` | `0` nothing registered; `2` planned repair now (`проводяться планові ремонтні роботи`); `3` emergency (`зареєстрована аварійна перерва`) | 0 → none; 2 → `REPAIR`; 3 → `EMERGENCY`. Any other value is unknown: show the text and treat it as `EMERGENCY` (conservative), and log it |
| `accident_str` | Start, `DD.MM.YYYY HH:mm`, Kyiv local, **no offset quirk** | `Outage.start` |
| `fn_accident_message` | Contains the estimated end as text: `… DD.MM.YYYY р. о HH годин(и) MM хвилин(и)` | `estimatedEnd` (regex, spaces vary). If it is missing, the outage is open-ended |
| `accident_id` | Stable POE id | Emergency id `poe_<accident_id>` (better than PowerOn's start-based id) |
| `gp_qnum_1`, `gp_qnum_2` | Queue `4` + `2` → `4.2`. **Both empty = the house is not in ГПВ** | Stored with the address; re-read on every refresh |
| `gav_message` | Feeder plus the schedules the house belongs to: `ГАВ (черга N)`, `АЧР`, `СГАВ`, `САВН`, `ГПВ (черга x-y)` | Shown as an info line; `ГАВ (черга N)` is kept for the ГАВ banner |
| `planned_message` | `<br>`-separated list: `… ремонтних робіт DD.MM.YYYY р. з HH-ї до HH-ї години.` | Future `REPAIR` outages (today and tomorrow are used; later ones are shown as text) |
| `accident_date` | Server time of the answer | Ignored (it can serve as a clock-skew hint) |

Live examples saved:
- `poe_result_type0_none.json`: Полтава, вул. Соборності 1, queue 1.1.
- `poe_result_type2_planned.json`: Сухорабівка, вул. Миру 77, queue 4.2, repair 09:34–17:00 plus four future days.
- `poe_result_type3_emergency_noqueue.json`: Зуївці, вул. Дружби 9, emergency 08:59–15:59, no queue.

At 15:32 the emergency with ETA 15:59 was still listed, so the existing overdue grace (60 min, `OUTAGE_ENGINE.md` 3.3) applies unchanged.

### 3.4 Branch registry (E5) and "пошкодження"

`out_text` = `<tr><td>16.11.2026 08:59:00</td><td>16.11.2026 15:59</td><td><b>с.Зуївці</b><br><b>вул.Дружби</b> (б. 1, 9, 15, …)<br>…</td><td>Аварійна перерва</td><tr>`

Reasons seen on 2026-11-16 (all 28 branches, 1 378 rows, 1.6 MB raw):

| Reason (4th cell) | Count | Kind |
|---|---|---|
| `Аварійна перерва` | 5 | **EMERGENCY**. online.poltava.ua shows these as `kind: "emergency"` / "**пошкодження**" (`poe-19-202611160859-…`, Зуївці) |
| `Планова перерва` | 39 | `REPAIR` (online.poltava: "планова") |
| `Застосування графіків обмеження споживачів (ГПВ 3-1)` | 1 311 | **Mirror of the queue schedule.** Ignore it, like PowerOn `switchSubReason = 2` |
| *(empty)* | 23 | Unknown. online.poltava labels them "planned". We treat them as `REPAIR` but never as "no outage" |

**Owner rule (2026-11-16): "пошкодження" counts as an emergency outage.**
- In POE terms: E4 `message_type = 3`, or an E5 row with reason `Аварійна перерва`.
- Both map to `OutageKind.EMERGENCY`.
- They go through `EmergencyLedger`: START / ETA_CHANGED / END notifications, the emergency switch, the emergency stripes on the drum.

The places cell mixes structured names (`<b>вул.X</b> (б. 1, 5)`) with free text (`Полтава, вул. Зінківська, 52`). Matching needs `StreetKey` after stripping the type prefix and an old name in brackets.

**The registry house lists are incomplete.** This is what online.poltava.ua shows when you expand an emergency card. Live check, Зуївці emergency 08:59–15:59, 2026-11-16:

| | Registry (E5) / online.poltava expanded card | Per-house E4 |
|---|---|---|
| вул.Дружби | 1, 9, 15, 17, 26, 28 | 9, 26 → emergency; **3 → emergency (not in the list)**; 2 → nothing |
| вул.Зелена | 2, 13, 23, 27 | (not probed) |
| вул.Молодіжна | 28 | (not probed) |

E4 resolves the house through its feeder (`КТП-476 Л-3`), so it knows about houses that the registry text omits. Matching the user's house against the registry list would have missed Дружби 3. The registry is therefore the **fallback** source and E4 the primary one (section 5.3). The registry list is still good for display: settlement → streets → houses, exactly as the expanded card shows it.

### 3.5 online.poltava.ua (not used at runtime)

Next.js app behind Cloudflare. For the record:
- `GET /api/outages/address?stage=cities|streets|houses&city=&street=` returns `{items, hromadas, aliases, uz}`.
- `POST /api/outages/address {city,street,house,queue,auto}` returns `{found, known, queue, queueSource:"poe", state…}` and `429` when rate-limited.
- `GET /api/outages/gav` returns `{active, types:[{family:"ГАВ",start:"08:57"}]}`.
- The schedule (`offIntervals`, `switchIntervals`, `poeStamp`) and the registry (`interruptions.items[]` with `kind: planned|emergency`, `filial`, ISO `startAt/endAt` with a correct `+02:00`) are embedded in the page's RSC payload, not in an API.

Two ideas worth borrowing: a flat oblast-wide settlement list with the hromada name for disambiguation (1 678 entries), and street aliases (old Soviet names → new names).

### 3.6 Fixtures

`spec/fixtures/poe/` (move into the test resources in P1):

| File | What |
|---|---|
| `poe_newgpv_2026-11-16.html` | E1, today, all 12 queues |
| `poe_unloading_2026-11-16.json` | E2: ГАВ from 08:54, ГОП 5 queues |
| `poe_cabinet_cities_filial123.json`, `poe_cabinet_buildings_poltava_sobornosti.json` | E3 |
| `poe_result_type0_none.json`, `poe_result_type2_planned.json`, `poe_result_type3_emergency_noqueue.json` | E4 |
| `poe_gavapi_filial19_2026-11-16.json` | E5 with an `Аварійна перерва` row |
| `onlinepoltava_*.json` | Cross-check samples |

---

## 4. Architecture

### 4.1 Repository

**Recommendation:** seed this repository from `Android-ZTBlackoutPreWarning` **with its history** (`git remote add upstream …; git merge upstream/main`), keep the same layout (`android/`, `ios/`, `spec/`, `src/`, `tests/`), and isolate everything Poltava-specific behind small interfaces. Core, UI and widget fixes made upstream can then be merged here and the other way round.

Rejected alternative: product flavours (`zhytomyr` / `poltava`) in one repo. That is cleaner long-term, but the owner already chose a separate repository, and flavours would touch the upstream CI and release flow, which `CLAUDE.md` says must not change without the owner.

### 4.2 Layers (both platforms)

```
            ┌───────────────────────── UI (unchanged screens, widgets) ─────────────────────────┐
            │ MainScreen  SettingsScreen  AboutScreen  Glance/WidgetKit  NotificationHelper      │
            └───────────────▲───────────────────────────────▲──────────────────────────────────┘
                            │ snapshot()                    │ planAlerts / transitions
            ┌───────────────┴──────────────┐   ┌────────────┴─────────────┐
            │ OutageRepository (unchanged  │──▶│ core/ (pure, vectors)     │
            │ contract: refresh/snapshot)  │   │ OutageEngine + SWITCHING  │
            └───────▲──────────▲──────────▲┘   │ EmergencyLedger           │
                    │          │          │    │ Subscriptions, AddressKeys│
     ScheduleSource │  AddressStatusSource│    │ PoeMapper (new, pure)     │
                    │          │  RegionNotices└───────────────────────────┘
            ┌───────┴──────────┴──────────┴─────────────────────┐
            │ data/poe/  (new)                                  │
            │  PoeHttp        form POST, gzip, 8 s timeouts      │
            │  PoeScheduleParser   E1 → 12×48 SlotState         │
            │  PoeAddressDirectory E3 + bundled index + cache   │
            │  PoeAddressStatus    E4 → queue, records, repairs │
            │  PoeRegistry         E5 → fallback records         │
            │  PoeNotices          E2 → SiteNotice (ГАВ/ГОП)     │
            └────────────────────────────────────────────────────┘
```

Interfaces, defined in `data/region/` so the Zhytomyr adapters could plug in again:

| Interface | Method | Replaces |
|---|---|---|
| `ScheduleSource` | `fetchDay(date): DayFetch` = `Published(12×48 SlotState, stamp)` / `NotPublished` / `Unavailable(reason)` | `ZtoeParser.fetchFullSchedule` |
| `AddressDirectory` | `branches()`, `settlements(branch)`, `streets(settlement)`, `houses(street)`, `search(text)` | `ZtoeAddressLookup` + `ZtoeStaticDirectory` |
| `AddressStatusSource` | `status(address): AddressStatus` = `Confirmed(queue?, emergencies, repairs, info)` / `Unavailable` | `PowerOnClient` + the queue part of the ztoe house list |
| `RegionNotices` | `active(date): List<SiteNotice>` | `SiteNotice` source |

### 4.3 Core changes (spec first, then Kotlin, TS, Swift)

1. **Slot state** `SlotState { ON, OFF, SWITCHING }` replaces the boolean slot in `normalizeSlots` / `buildPlanned`. **Behaviour (owner decision D3, approved):**
   - an outage span is built from `OFF` cells only, so alerts fire at the s2 start, which matches POE's period list;
   - a `SWITCHING` cell right after a span adds `restoreWindowEnd` to that span: the countdown reads "світло повернеться 07:00–07:30" and the drum draws that cell amber;
   - a stand-alone `SWITCHING` cell (for example 00:00–00:30 after yesterday's block) is drawn amber and never alerts.
   - New vectors are added to `outage_engine.json`; the existing ones still pass, since without s3 nothing changes.
2. **Address without a queue.** A subscription may have `queue = null`. The engine gets no planned outages for it. The UI shows "Ваша адреса не входить до графіків погодинних відключень", and emergencies and repairs still work. `Subscriptions` repair rules get one new case and one new vector.
3. **Emergency id** `poe_<accident_id>`, with a fallback to `poe_<start>` when the id is null. The ledger merge rules (`POWERON_API.md` 5.1 step 7: overlapping or touching records merge) stay.
4. **`PoeMapper`** (pure, replaces `PowerOnMapper`):
   - `parseTime("16.11.2026 08:59")`;
   - `parseEta(text)` (`о 15  годин(и)  59 хвилин(и)`, variable spaces; also `до 17-ї години`);
   - `parsePlannedList(text, today)`;
   - `parseQueue(q1, q2)`;
   - `classifyRegistryReason(reason)`;
   - `parsePlaces(html)` → `[(settlement, street, houses[])]`.
   - All of them get golden vectors in `spec/vectors/poe_api.json`, built from the saved fixtures.

### 4.4 Address model and picker

```
PoeAddress {
  branchCabinetId: Int, branchRegistryId: Int, branchName,
  cityId: Int, cityName,             // "село Сухорабівка"
  streetIds: [Int], streetName,      // all ids merged by StreetKey ("вул. Миру" / "вул.Миру ")
  house: String,                     // exact instance_name as POE returns it (E4 matches on the name)
  queue: String?                     // from E4, refreshed every sync
}
```

- **Picker:** keep the existing four searchable steps (`SearchablePickerField`). The steps are renamed Філія/дільниця → Населений пункт → Вулиця → Будинок.
- **Oblast-wide search (D4, approved):** the settlement field also searches the whole oblast. A bundled index `settlement → branch`, built by `scripts/build-poe-directory.(cjs|kts)` from E3 for all 28 branches (28 small requests), fills the branch automatically, because most users do not know their дільниця. Duplicate settlement names are shown with their branch.
- **Queue resolution:** choosing a house calls E4 once. The queue comes back with the first status. If the queue later changes, the address is updated and a one-line notice is shown.
- **Directory data and refresh (three layers):**
  1. **Bundled snapshot.** Branches, settlements and streets from the crawl (`scripts/crawl_poe_directory.py`, first run 2026-11-16, about 1 700 requests in 60 min, 0 failures). Result `docs/research/directory/poe_directory_2026-11-16.json`: 28 branches, **1 777 settlements** (unique `city_id`), **20 395 streets**; 948 KB compact JSON, **172 KB gzipped**. Findings that shape the model:
     - `city_id` and `street_id` are **global**, not per branch: the branch only filters the settlement list. 86 settlements appear under several branches with the same id and the same streets (м. Полтава under 9 branches, 1 044 streets; Кременчук under 3; Горішні Плавні under 2). The directory is keyed by `city_id` with a list of branches, and the oblast-wide search shows each settlement once.
     - So the branch step is only a filter. A settlement in several branches needs no branch choice for E3/E4 (they take `city_id`); the registry card (section 5.4) queries every branch listed for the settlement.
     - Junk entries exist (`село _`) and are dropped; 4 settlements returned no streets (reason not checked yet; check them in P2 before deciding how the picker handles a settlement without streets).
     - Street names carry trailing spaces and old names (`вул. Соборності `): `StreetKey` normalisation applies. Houses are not bundled: the picker loads them live, one small request per street, cached for 7 days.
  2. **Weekly server-side refresh.** A GitHub Actions job reruns the crawl and commits `directory.json` to this repository. The app checks it like `donations.json` (raw GitHub URL, conditional request, nothing downloaded when unchanged). Users get new streets without an app update, and POE sees one crawl a week instead of one per user.
  3. **Scoped refresh on the device** for "my address is missing" (Settings → address picker):
     - missing house: houses are always fetched live, so the list is current;
     - missing street: «Оновити вулиці цього населеного пункту», 1 request to POE (E3), about a second;
     - missing settlement: refresh that branch's settlement list, 1 request;
     - «Оновити довідник повністю» downloads the latest `directory.json` from the repository, **never** a full crawl of POE from the phone (about 1 700 requests for streets, tens of thousands with houses: too slow for Android background limits and too much load on POE).
- **"Знаю свою чергу":** the queue-only mode (no address) stays, as in Zhytomyr.

### 4.5 Refresh and traffic

Per refresh (default 30 min, floor 15 min on Android):
- E1 today + E1 tomorrow (about 14 KB + 0–14 KB gzipped);
- E2 (under 1 KB);
- E4 once per address (up to 5 × about 1.5 KB).

E5 runs only when E4 is `Unavailable`, and only for the address's branch (about 50 KB gzipped). Total is about 30 KB per refresh, about 1.5 MB a day at a 30-minute interval. Since there is no ETag, a content hash of the E1 body skips re-parsing and DB writes. Timeouts are 8 s / 8 s, and an E4 answer is cached for 60 s per address (from `spec/config.json`).

### 4.6 Site state and fail-safe (unchanged rules, new mapping)

| POE result | `SiteState` |
|---|---|
| E1 200, table parsed for the requested date | `AVAILABLE_WITH_TABLE` |
| E1 200 with an empty body (tomorrow) / a "не застосовувати" text | `AVAILABLE_NO_TABLE` (for that day only) |
| E1 200 with a JSON error body (`"status":400`) / unparsable HTML | `SITE_UNREACHABLE` (format changed); keep the cache and report a parser error |
| Network error | `NO_INTERNET` / `SITE_UNREACHABLE` per `NetworkProbe` |

E4 or E5 failing → `EmergencyFetch.Unavailable`. It never means "no emergency", and the ledger stays unchanged.

### 4.7 Rebranding and invariants that change

| Item | Zhytomyr | Poltava |
|---|---|---|
| App name | `Світло в Житомирі` | **`Світло в Полтаві`** (D1); iPhone home-screen name `Світло` |
| Android `applicationId` | `com.ZTBlackoutPreWarning` | new, for example `ua.blackout.prewarning.poltava`. Kotlin `namespace` stays `ua.blackout.prewarning` to keep upstream merges cheap |
| Signing | committed `debug.keystore` | **a new keystore**: a Poltava APK must never install over the Zhytomyr one |
| iOS bundle id / App Group | `…prewarning` / `group.ua.blackout.prewarning` | new ids in the same team |
| Queue help dialog (4 steps, asserted char-for-char) | points to ztoe.com.ua | rewritten for the POE flow; tests updated with the owner's text |
| Emergency link on Main (asserted) | `facebook.com/ztoe.com.ua` | **`https://www.facebook.com/atpoltavaoblenergo`** (D2), same Facebook icon and label |
| `valid-urls.json` | ztoe URL | `https://www.poe.pl.ua/customs/` endpoints |
| «Житомирська Рулетка» | Android + web | **Dropped in v1** (D5): screen, assets (`res/raw/*.mp3`, `drawable-nodpi/ticket_*`), entry point and the web `ZhytomyrRouletteModal` removed |
| Version | 1.4.0 | **1.0.0** (D7), own version line |
| Disclaimer | "not official, data from ztoe" | "not official, data from poe.pl.ua". No POE logo anywhere |
| Donations | `donations.json` from the upstream repo | URL switched to this repository's `main` |
| Widget labels, defaults (15 / 30 min), countdown format | unchanged | unchanged |

### 4.8 Web simulator (`src/`)

**Full parity (D6).** The web simulator stays a complete mirror of the Android build, as in Zhytomyr: same screens, widgets, texts, data rules and expected outcome.
- `src/core` gets the core changes (`SlotState`, no-queue, emergency id) and `PoeMapper`; `tests/spec-vectors.test.ts` runs every vector file.
- `src/services/` gets the POE adapters in place of `ztoeParser.ts`, `ztoeAddressLookup.ts` and `poweronClient.ts`. The Vite dev proxy `/proxy-ztoe` becomes `/proxy-poe` (`https://www.poe.pl.ua/customs/`), since POE sends no CORS headers for other origins.
- `MainView.tsx`, `SettingsView.tsx`, `AboutView.tsx`, `WidgetSimulator.tsx` and `i18n.ts` mirror the Android changes, including the amber switching cells, the no-queue card and the nearby outages card (section 5.4).
- The code explorer (`src/data/androidProjectFiles.ts`), the APK zip and the Play guide follow the Android sources as before.
- The invariant tests in `tests/unit.test.ts` move to the Poltava values (name, Facebook link, queue help text, version 1.0.0).

---

## 5. Emergency and repair pipeline (detail)

### 5.1 Sources per address

1. **Primary: E4 per house.**
   - `message_type 3` → one `EmergencyRecord(id=poe_<accident_id>, start=accident_str, estimatedEnd=parseEta, label="Аварійна перерва")`.
   - `message_type 2` → one `REPAIR` outage for now.
   - `planned_message` → `REPAIR` outages for today and tomorrow.
2. **Fallback: E5 for the address's branch**, used when E4 is `Unavailable`. ГПВ mirror rows are dropped. For `Аварійна перерва` and `Планова перерва` rows, at the address's settlement:
   - house listed (`HouseKey`) → `EmergencyRecord(id=poe_<start>)` / `REPAIR`, *confirmed*;
   - street listed but the house is not → a *possible* outage. It is shown as "аварія на вашій вулиці" with the street's house list (registry lists are incomplete, section 3.4). It does not feed the ledger, so it never sends START or END, and it never counts as "no outage".
   - settlement listed but the street is not → no outage for this address, but the existing "unknown" state stays visible because E4 failed.
3. If both fail → `Unavailable`. The ledger does not change and no END notification is sent.

### 5.2 Ledger and notifications

These are unchanged from `spec/NOTIFICATIONS.md`:
- START when a new record appears;
- ETA_CHANGED when the estimate moves by at least 10 min;
- END when a record is missing from a **confirmed** answer (or stale after the 60-minute grace).

A planned + emergency outage back to back stays one continuous outage (`emergencyDelivery`). The existing far-future filter applies: emergency records with a start on or after the day after tomorrow are dropped before `reconcile`.

### 5.3 Why E4 is primary

- It answers for the exact house, so there is no fuzzy street matching.
- It carries POE's stable `accident_id` and the queue in the same call.
- It costs 1.5 KB.

E5 needs HTML place parsing with free-text rows, and its house lists miss houses that E4 knows (Зуївці, вул. Дружби 3, section 3.4), so it is the safety net.

### 5.4 Card «Ремонти й пошкодження поруч» (D9, approved)

New card on the **main screen, directly above the timer (hero countdown) card**. It is **not** on the widgets and **not** in the drum chart.

- **Data:** E5 rows of the active address's branch for today, filtered to the address's settlement; ГПВ mirror rows dropped. One branch request (about 50 KB gzipped) per refresh, cached with the snapshot; a failed fetch keeps the last list and shows its time.
- **Content:** one row per outage: kind chip (**пошкодження** = `Аварійна перерва`, red; **планова** = `Планова перерва` or empty reason, grey), time range, status (зараз / о HH:MM / завершено), duration, street names. Tapping a row expands it to the streets with their house lists (settlement → street chips with houses), as on online.poltava.ua.
- **The user's street** is highlighted; if their house is in the list, the row says so. The card stays display-only for rows that only name the street. Owner, 2026-11-17: a row whose house list names the user's house becomes a repair outage of the address (drum, list, timer, pre-warning; `spec/POE_API.md` 8.10a), and repair works are drawn with the emergency amber stripes.
- **Empty state:** the card is hidden when the settlement has no rows today; queue-only subscriptions (no address) do not show it.
- **Parity:** same card in the web simulator (`MainView.tsx`) and iOS (`MainScreen.swift`); its strings go into `AppStrings.kt` first.

---

## 6. Android milestones

Each milestone is a PR into a feature branch. CI must stay green (`npm test`, Gradle unit tests, APK/AAB), and a push to `main` publishes a release, same as upstream.

| | Deliverable | Done when |
|---|---|---|
| **P0 Seed + rebrand** | Merge upstream history; new `applicationId`, keystore, name, icon placeholder; `CLAUDE.md` / `README` / `HANDOVER` say Poltava; invariant tests updated to the new name, Facebook link and version 1.0.0; roulette removed on Android and web (D5); CI publishes to this repository's Releases | A debug APK installs **next to** the Zhytomyr app, still showing Zhytomyr data |
| **P1 Spec** | `spec/POE_API.md` (sections 3.1–3.4 of this plan, cleaned up), `spec/branches.json` (28 branches, both ids), `SlotState`/switching in `OUTAGE_ENGINE.md` + `UI_DRUM.md`, no-queue rule in `SUBSCRIPTIONS.md`, `spec/vectors/poe_api.json` (time, ETA, planned list, queue, reason, places), new `outage_engine.json` cases; fixtures moved to test resources | Vectors written; Kotlin and TS runners updated to load them (red until P2) |
| **P2 Core + data** | `SlotState` in `OutageEngine`; `PoeMapper`; `data/poe/*` (section 4.2); bundled directory snapshot from `scripts/crawl_poe_directory.py` + weekly CI job publishing `directory.json` + in-app conditional check (section 4.4); the same adapters in `src/services/` (D6); delete `ZtoeParser`, `ZtoeAddressLookup`, `ZtoeStaticDirectory`, `PowerOnClient`, `PowerOnMapper` and their tests (and their entries in `src/data/androidProjectFiles.ts` **before** running `generate_android_project.cjs`) | All vectors green on Kotlin and TS; parser tests green on the fixtures; a CI job does one live fetch of E1/E2/E4 and prints the parsed table |
| **P3 Repository + subscriptions** | `OutageRepository` on the four interfaces; `PoeAddress` in `SubscriptionRepository` (versioned JSON, fresh store, no migration needed for a new app); queue refresh from E4; no-queue addresses; ledger with `poe_<accident_id>` | Unit tests: E4 type 0/2/3 fixtures → expected outages and ledger events; E4 down + E5 fixture → same emergency |
| **P4 UI** | Picker labels + oblast-wide settlement search + scoped "address missing" refresh buttons (section 4.4); «Ремонти й пошкодження поруч» card above the timer card (section 5.4, D9); queue help text (drafted for the POE flow, approved by the owner before the test asserts it); emergency link `facebook.com/atpoltavaoblenergo` (D2); amber switching cells + "світло повернеться HH:MM–HH:MM"; no-queue card; ГАВ/ГОП banner from E2 via the SiteNotice card; `gav_message` info line under the address; About/disclaimer; `CHANGELOG.md` entries for every touched `ui/` / `widget/` file (enforced by `npm test`); every change mirrored in the web simulator (D6) | Screens, widgets and the web simulator compared with Zhytomyr 1.4.0 screenshots; widget drum = main drum (48 states, now tri-state) test green |
| **P5 Device validation** | One week on a real phone: alerts on time with the app killed, widget transitions at s2/s3 boundaries, emergency START/END on a real outage, battery check (target ≈ upstream's 5.5 mA/h), traffic check (section 4.5) | Checklist in `docs/` signed off by the owner |
| **P6 Release** | v1.0.0 (D7), APK on GitHub Releases (D8); README in Ukrainian with screenshots; privacy policy naming `www.poe.pl.ua` and what is sent (city/street ids + house number go to POE in E4, which is new compared with PowerOn: state it); Play listing if wanted | Tagged release; APK downloadable |

Rough size: about 1 400 lines of Zhytomyr adapters are deleted and about 1 000–1 300 lines of POE adapters, mapper and tests are added; the core changes are small; UI changes are mostly text plus one new cell colour.

---

## 7. iOS milestones (after P3 is stable)

The upstream `ios/` (SwiftUI + WidgetKit, iOS 17+, XcodeGen, CI-built on GitHub macOS runners, TestFlight via API key) comes with the merge in P0. Same approach: `Shared/Core` takes the core changes, `Shared/Data` gets `Poe*` in place of `Ztoe*` / `PowerOn*`, and the UI and widgets keep their structure.

| | Deliverable | Done when |
|---|---|---|
| **I0 Ids + CI** | New bundle ids (app + widget), new App Group, `CFBundleName` `Світло в Полтаві` (`CFBundleDisplayName` short), `build-ios.yml` geo-check switched to `www.poe.pl.ua` (App Review runs outside Ukraine, R1 in the upstream iOS plan) | Empty-data app builds on CI; geo-check result recorded |
| **I1 Core** | `SlotState`, no-queue, `PoeMapper` in Swift; `SpecVectorsTests` reads `../spec/vectors` incl. `poe_api.json` | All vector files green, case counts asserted |
| **I2 Data** | `PoeHttp` (URLSession, form POST), parsers (schedule: a regex scanner over `td.gpv-c` classes, no HTML DOM dependency), directory + bundled index in the App Group, `AddressStatus`, `Registry`, `Notices` | Fixture tests green; live CI fetch prints the table |
| **I3 Screens** | Same as P4 on iOS; `AppStrings.swift` regenerated from `AppStrings.kt` (`scripts/ios-strings.cjs`) | Gallery screenshots iOS 26 / 17 match Android |
| **I4 Notifications + widgets** | `NotificationPlanner` (≤ 40 pending), emergency events, `BGAppRefreshTask`; widgets with amber switching cells; `SelectAddressIntent` | Planner test on vectors; device checks via TestFlight |
| **I5 Review + TestFlight** | Privacy manifest, review notes (unofficial app, public POE endpoints), screenshots uk/en, App Store text | Build installed from TestFlight |

---

## 8. Risks

| Risk | Mitigation |
|---|---|
| POE endpoints are internal (WordPress PHP proxies to `poeREST … /v2`) and can change without notice | Tri-state results everywhere; strict parser validation (date in the header, 12×48 cells); a daily CI live-probe job that fails loudly; the cached schedule is never cleared |
| E1 returns HTTP 200 for errors (JSON `400` inside) | Treat a non-HTML body as `Unavailable`, never as "no schedule" |
| Rate limits unknown | Requests stay well under 1/min per device; 60 s E4 cache; no oblast-wide E5 sweeps on devices (the directory crawl runs in CI/scripts only) |
| E4 sends the house number to POE (PowerOn got only street ids) | Disclosed in the privacy policy; the request goes to the utility itself |
| Text parsing of ETA / planned lists (`годин(и)`, double spaces, `08-ї`) | Golden vectors from real samples; an unparsable ETA → open-ended emergency (still alerts START), never dropped |
| The switching state is interpreted differently by different sites | Owner decision D3, pinned by vectors |
| App Review / Play: unofficial use of the utility's name | Same R2/R3 measures as upstream: disclaimer, no logo, external links in the browser |
| Upstream divergence | Keep the namespace and file layout, isolate POE code in `data/poe/` + `core/PoeMapper`, merge upstream regularly |

---

## 9. Owner decisions (2026-11-16)

| # | Question | Decision |
|---|---|---|
| D1 | App name | **`Світло в Полтаві`** (`CFBundleDisplayName` `Світло`) |
| D2 | Emergency link on Main (an asserted invariant) | **`https://www.facebook.com/atpoltavaoblenergo`** |
| D3 | Switching half-hour (`gpv-s3`) | **As recommended:** not part of the outage span; amber cell + "повернеться HH:MM–HH:MM"; never alerts |
| D4 | Picker | **As recommended:** keep the 4 steps, add oblast-wide settlement search that fills the branch |
| D5 | Roulette | **Dropped in v1** (Android and web) |
| D6 | Web simulator | **Full parity** with the Android build in UI and functionality (section 4.8) |
| D7 | Version line | **1.0.0** |
| D8 | Distribution | **GitHub Releases APK first**, Play later |
| D9 | «Ремонти й пошкодження поруч» card (section 5.4) | **In v1**, on the main screen above the timer card; not on widgets, not in the drum |
| — | Address directory refresh | Bundled snapshot + weekly CI refresh + scoped in-app refresh (section 4.4), accepted with the owner's "update list" idea |

Queue help dialog for the POE flow: the 4-step text drafted in P4 was approved by the owner on 2026-11-16 and is asserted by the tests (`AppStrings.queueHelpSteps`, `i18n.ts`, `AppStrings.swift`).
