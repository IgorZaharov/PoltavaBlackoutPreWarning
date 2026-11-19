# iOS for «Світло в Полтаві»: readiness report and work plan (I0–I5)

| | |
|---|---|
| Written | 2026-11-19 |
| Status | Owner agreed the identifiers and the CI change on 2026-11-19; **I0 on branch `feat/ios-i0-ids`** (section 9 holds the geo-check result). Milestones from `docs/POLTAVA_PORT_PLAN.md` section 7; the iOS rules (Liquid Glass, App Review R1–R13, CI as the only compiler) from `docs/ios/IOS_PORT_PLAN.md` stay. |
| Base | `feat/p4-poe-ui` at `0aef4e8` (iOS CI run 44072194503 green: the Zhytomyr data layer still compiles and its tests pass) |

## 1. Where `ios/` stands today

- **Done in P0–P4 on iOS:** `CFBundleName` «Світло в Полтаві», `CFBundleDisplayName` «Світло», `MARKETING_VERSION` 1.0.0, `AppStrings.swift` regenerated from the Poltava `AppStrings.kt` (POE texts, queue help, Facebook link), the yellow needle, the 3-hour widget hour marks, repair works drawn with the emergency stripes (`OutageEngine.swift`), the POE entry in `valid-urls.json` (next to the ztoe one).
- **Still Zhytomyr:**
  - identifiers: bundle ids `ua.blackout.prewarning` / `.widget` / `.tests`, App Group `group.ua.blackout.prewarning`, background task `ua.blackout.prewarning.sync`, URL scheme `svitlozt`. They are the **Zhytomyr iPhone app's** ids in the same team, so a Poltava build can neither go to App Store Connect as its own app nor sit next to the Zhytomyr app on one phone;
  - data layer: `ZtoeParser`, `ZtoeAddressLookup` (1 586 lines), `ZtoeStaticDirectory`, `PowerOnClient`, `core/PowerOnMapper`; screens with the REM step;
  - CI: the geo-check probes ztoe and PowerOn, `LiveFetchTests` fetch ztoe and PowerOn, the launch step starts `ua.blackout.prewarning`;
  - the app icon (`AppIcon-1024.png` is the Zhytomyr icon).
- **Missing compared with Poltava Android:** the POE core (switching cells, no-queue address, `PoeMapper`, `PoeSchedule`, `QueueCatalogue`), the POE data layer, the P4 screens, and the upstream iOS 1.4.1–1.4.2 work that Poltava Android already has (first-run tour, address edit in place, pull to refresh, widget address swipe; upstream `ios/` is 30 files / about 1 100 lines ahead of ours).
- **Not set in this repository:** the TestFlight secrets (`APPLE_TEAM_ID`, `ASC_KEY_ID`, `ASC_ISSUER_ID`, `ASC_KEY_P8`). Needed in I5 only.

## 2. File mapping

### 2.1 Pure core (`android/.../core/*.kt` = `src/core/*.ts` = `ios/Shared/Core/*.swift`)

| Kotlin | TypeScript | Swift | Work |
|---|---|---|---|
| `OutageModels.kt` | `outageModels.ts` | `OutageModels.swift` | I1: three-state cell (`ScheduleCell` ON/OFF/SWITCHING), `switchWindows`, `SlotState.switching`, `StatusInfo.restoreUntil` |
| `OutageEngine.kt` | `outageEngine.ts` | `OutageEngine.swift` | I1: spans from OFF cells only, switching windows, `restoreUntil` (`OUTAGE_ENGINE.md` 3.5) |
| `Subscriptions.kt` | `subscriptions.ts` | `Subscriptions.swift` | I1: no-queue address, `setAddress`, widget address stack (`SUBSCRIPTIONS.md`) |
| `PoeMapper.kt` | `poeMapper.ts` | `PoeMapper.swift` (new) | I1: times, ETA, planned list, queue, `addressStatus`, registry reason/rows/places/match, `nearbyOutages`, `registryRepairs` |
| `PoeSchedule.kt` | `poeSchedule.ts` | `PoeSchedule.swift` (new) | I1: regex scanner over `td.gpv-c` classes, date check, empty body = not published |
| `QueueCatalogue.kt` | `queueCatalogue.ts` | `QueueCatalogue.swift` (new) | I1 |
| `EmergencyLedger.kt`, `AddressKeys.kt`, `SiteState.kt`, `SiteNotice.kt` | same names | same names | unchanged since the seed; keep |
| (`data/KyivZone.kt`) | `localTime.ts` | `KyivTime.swift` | keep |
| (`ui/components/PickerSearch.kt`) | | `PickerSearch.swift` | keep |
| `PowerOnMapper.kt` (deleted in P2) | `poweronMapper.ts` (deleted) | `PowerOnMapper.swift` | delete in I2, with its vectors |

### 2.2 Data layer (`data/poe/`, `data/repository/` = `src/services/` = `ios/Shared/Data/`)

| Kotlin | TypeScript | Swift |
|---|---|---|
| `poe/PoeTransport.kt` (form POST, gzip, 8 s) | `poeClient.ts` | `PoeTransport.swift` (new, on `Http.swift`) |
| `poe/PoeClient.kt` (E1 E2 E3 E4 E5) | `poeClient.ts` | `PoeClient.swift` (new), replaces `PowerOnClient.swift` |
| `poe/PoeScheduleSync.kt` | `poeScheduleSync.ts` | `PoeScheduleSync.swift` (new), replaces `ZtoeParser.swift` |
| `poe/PoeAddressLookup.kt`, `PoeDirectoryIndex.kt`, `PoeBranches.kt` | `poeAddressLookup.ts`, `poeDirectory.ts` | `PoeAddressLookup.swift`, `PoeDirectoryIndex.swift`, `PoeBranches.swift` (new), replace `ZtoeAddressLookup.swift` and `ZtoeStaticDirectory.swift` |
| `poe/PoeQueues.kt` | `poeQueues.ts` | `PoeQueues.swift` (new) |
| `repository/OutageRepository.kt`, `OutageStateStore.kt`, `ScheduleRepository.kt` | `outageRepository.ts`, `outageStore.ts`, `scheduleCache.ts` | same names (rework: three-state cells, E4 per address, queue write-back, registry card) |
| `repository/SubscriptionRepository.kt`, `SubscriptionSync.kt`, `SettingsRepository.kt`, `AlertRegistry.kt`, `DonationsRepository.kt`, `net/NetworkProbe.kt` | | same names (small changes: POE address fields, `city_url`) |

### 2.3 Screens and widgets (I3, I4)

`MainScreen.kt` / `MainView.tsx` → `MainScreen.swift`; `SettingsScreen.kt` + picker → `SettingsScreen.swift`, `AddressLookupSheet.swift`, `SearchablePicker.swift`; `AboutScreen.kt` → `AboutScreen.swift`; `TimelineBar.kt` + `DrumCells` → `Design/TimelineBar.swift`; `BlackoutGlanceWidget.kt` → `Shared/Widget/WidgetViews.swift`. New on iOS: the nearby-outages card, the measures (E2) card, the no-queue card, the `gav_message` line, the switching cells, the scoped refresh buttons, the company search, plus the upstream 1.4.1–1.4.2 UI (section 1).

## 3. Vectors the XCTest target must read

`spec/vectors` is already a folder resource of the test target (`ios/project.yml`), so nothing is copied. Every file gets a runner with an asserted case count (a file or group that runs 0 cases fails), as `SpecVectorsTests.swift` does today:

| File | Groups (cases today) | Swift runner |
|---|---|---|
| `poe_api.json` | `times` 10, `eta` 7, `plannedList` 5, `queue` 8, `addressStatus` 12, `registryReason` 6, `registryRows` 6, `registryMatch` 9, `nearby` 6, `registryRepairs` 6 | `PoeVectorsTests.swift` (new, ports `PoeVectorsTest.kt`) |
| `outage_engine_poe.json` | `cases` 7 | same |
| `poe_schedule.json` | `cases` 13 | same |
| `queue_catalogue.json` | `entries` 12, `cases` 14, `confident` 6 | same |
| `subscriptions.json` | new cases since the seed: `setAddress`, `widget` stack (4) | `SubscriptionVectorsTests.swift` (extend) |
| `outage_engine.json`, `emergency_ledger.json`, `address_keys.json`, `site_state.json`, `site_notice.json` | unchanged | `SpecVectorsTests.swift` (keep) |
| `poweron_api.json` | iOS only reader left | delete the runner in I2, then the file |

The HTML and JSON fixtures in `spec/fixtures/poe/` feed the data-layer tests in I2 (as `PoePipelineTest.kt` and `PoeClientTest.kt` do); the test target gets `../spec/fixtures/poe` as a second folder resource.

## 4. What is removed, and when

| Item | Removed in | Condition |
|---|---|---|
| `ZtoeParser.swift`, `ZtoeAddressLookup.swift`, `ZtoeStaticDirectory.swift`, `PowerOnClient.swift`, `core/PowerOnMapper.swift`, `Tests/Fixtures/ztoe_schedule_live.html`, `StreetDedupTests.swift` (ztoe parts), the ztoe parts of `DataLayerTests.swift` and `LiveFetchTests.swift` | I2 | the POE adapters and their tests are green |
| `spec/POWERON_API.md`, `spec/vectors/poweron_api.json`, `spec/rems.json`, the `testPowerOnVectors` runner | I2, same PR | no Swift file reads them any more (Kotlin and TS stopped in P2). `grep -r poweron_api tests android src ios` must be empty |
| ztoe entry in `valid-urls.json` (all four copies) and `SettingsRepository.DEFAULT_URL` = ztoe | I2 | iOS reads `city_url` from POE; `npm test` keeps the four copies in sync |
| ztoe and PowerOn probes in the CI geo-check | I2 (POE probes are added in I0) | needs the owner's OK for `.github/` |
| `CLAUDE.md` lines that keep `POWERON_API.md`, `poweron_api.json` and the ztoe entry "until I1–I2" | I2 | |

## 5. Bundled data

- `poe_directory.json` (971 KB, compact) and `poe_queues.json` (2.3 MB) are copied to `ios/Resources/` as the fifth/fourth synced copies; `tests/unit.test.ts` adds `ios/Resources` to both sync checks, and `.github/workflows/poe-data.yml` must also refresh the iOS copy (owner's OK for `.github/`).
- Both go into the **app target only**. The widget never runs the picker, and the extension's memory limit (about 30 MB) is better spent on drawing. The app reads them from the bundle once and keeps a parsed index in memory (Android `PoeDirectoryIndex`); the 7-day house cache goes to the App Group container as JSON (`PERSISTENCE.md` 6).
- Weekly refresh without an app update: same conditional download of `poe_directory.json` from this repository as Android (`POLTAVA_PORT_PLAN.md` 4.4 layer 2), stored in Application Support.

## 6. Name, identifiers and icon

| Item | Today (Zhytomyr) | Proposed (Poltava) |
|---|---|---|
| App bundle id | `ua.blackout.prewarning` | `ua.blackout.prewarning.poltava` (same as the Android application id) |
| Widget bundle id | `ua.blackout.prewarning.widget` | `ua.blackout.prewarning.poltava.widget` |
| Test bundle id | `ua.blackout.prewarning.tests` | `ua.blackout.prewarning.poltava.tests` |
| App Group | `group.ua.blackout.prewarning` | `group.ua.blackout.prewarning.poltava` |
| Background task | `ua.blackout.prewarning.sync` | `ua.blackout.prewarning.poltava.sync` |
| Widget URL scheme | `svitlozt` | `svitlopoltava` (a shared scheme would let the Zhytomyr widget open the wrong app) |
| Xcode project name | `SvitloZhytomyr.xcodeproj` | `SvitloPoltava.xcodeproj` (CI names it, so `.github/` changes) |
| `CFBundleName` / `CFBundleDisplayName` | done | «Світло в Полтаві» / «Світло» |
| Icon | Zhytomyr 1024 px | I3: `scripts/build_app_icons.py` also writes `ios/Resources/Assets.xcassets/AppIcon.appiconset/AppIcon-1024.png` from `public/logo.png` (opaque, no alpha: App Store Connect rejects transparent icons; the black outside the rounded square becomes the maroon background, iOS applies its own mask) |

The Kotlin namespace stays `ua.blackout.prewarning`; on iOS only the strings above change, the Swift module and target names (`ZTPreBlackout`, `BlackoutWidgetExtension`) stay so upstream iOS fixes merge cleanly. The new app needs a fresh App Group store, so there is no migration from the Zhytomyr keys.

Before I5 (owner, Apple Developer and App Store Connect): register the two App IDs and the App Group (or let the cloud-signing archive create them), create the App Store Connect app record «Світло в Полтаві», and set the four secrets in this repository.

## 7. Milestones

Every milestone is one PR into the Poltava feature branch, never `main`; done = a green `build-ios.yml` run, whose log and screenshots are the evidence.

| | Deliverable | Done when |
|---|---|---|
| **I0 Ids + CI** | Section 6 ids in `project.yml`, both `Info.plist`s, both entitlements, `AppGroup.swift`, `BackgroundRefresh.swift`, `NetworkProbe.swift`, the widget URL, `ios/scripts/*.sh`; CI: launch step reads the bundle id from the built `Info.plist`, geo-check adds POE E1 (today), E3 (Полтава cities), E4 (Соборності 1) and E5 (branch 23), project name; `tests/unit.test.ts` asserts the Poltava ids and that no `ios/` file names the Zhytomyr App Group | CI green; geo-check result for `www.poe.pl.ua` recorded in this file |
| **I1 Core** | Section 2.1 in Swift; `PoeVectorsTests.swift`; new `subscriptions.json` cases | All 11 vector files run with asserted counts, green. **Branch `feat/ios-i1-core`** (2026-11-19): switching cells in the engine, `PoeMapper`, `PoeSchedule`, `QueueCatalogue`, `PoeVectorsTests` (the four POE files, every group with its count). The `subscriptions.json` cases for `setAddress` and the widget address stack come with the Android commit that adds them (`9cadc9b`, not pushed yet); their Swift side exists upstream (Zhytomyr iOS 1.4.2) and follows then. The registry rule of `POE_API.md` 8.10a is ported as it is today, including the known duplicate with an E4 emergency; the fix lands in the spec and the vectors first. |
| **I2 Data** | Section 2.2; bundled data (section 5); fixture tests from `spec/fixtures/poe/`; `LiveFetchTests` on POE (E1 + E4 + E5, prints the 12×48 table); removals of section 4 | Fixture and live tests green; no `ztoe`/`PowerOn` left in `ios/`. **Branch `feat/ios-i2-data`** (2026-11-19): `Poe*.swift` data layer, `OutageRepository.swift` on POE (queue write-back, measures, `gav_message`, nearby card, registry repairs), bundled `poe_directory.json` / `poe_queues.json` in the app target, the widget resolves saved addresses from `poe_resolved_v1.json` in the App Group, `PoeDataTests.swift`, `LiveFetchTests.swift` on POE (skips when the runner cannot reach POE). The address sheet uses the POE lists with the inherited layout; the P4 picker is I3. CI (owner's OK 2026-11-19): the geo-check probes POE only, `poe-data.yml` refreshes the iOS copies. Left: `spec/POWERON_API.md` and `spec/rems.json` stay while `NOTIFICATIONS.md`, `POE_API.md`, `PERSISTENCE.md` and `SUBSCRIPTIONS.md` cite them. Swift names kept from 1.4.0 as on Android (`PowerOnSnapshot`, `poweron` keys, core comments). |
| **I3 Screens** | P4 screens on iOS (section 2.3), the upstream 1.4.1–1.4.2 UI, the icon; `CHANGELOG.md` names every touched `ios/App/UI/` file | Gallery screenshots iOS 26 / 17 side by side with the Android P4 screens |
| **I4 Notifications + widgets** | Switching cells in the widget drums, one alert per span, emergency START/ETA/END from E4, widget address stack, `BGAppRefreshTask` on POE | Planner and widget tests green; TestFlight device checks |
| **I5 Review + TestFlight** | Privacy policy and manifest name `www.poe.pl.ua` and that the house number goes to POE in E4; review notes; App Store screenshots and text (uk/en) | Build installed from TestFlight |

Two simulator bugs seen on 2026-11-18 matter for I1/I3: a registry row naming the house becomes a repair even when E4 reports the same span as an emergency (`POE_API.md` 8.10a, tomorrow shows it twice), and the primary address chip does not switch the address in the web simulator. The first is a spec/core rule: it is fixed in the spec and a vector first, then ported to Swift with the rest of `PoeMapper`; I1 waits for that fix or ports the corrected rule.

## 8. Owner decisions

1. Identifiers of section 6: **approved 2026-11-19** as proposed.
2. `.github/workflows/build-ios.yml` may change in I0 (launch step, geo-check, project name): **approved 2026-11-19**. In I2 the ztoe and PowerOn probes leave the geo-check and `poe-data.yml` refreshes the iOS copies of the data files: **approved 2026-11-19**.

## 9. Geo-check result (I0, App Review R1)

CI run 44409083888 (2026-11-18 22:11 UTC, GitHub-hosted `ubuntu-latest`, outside Ukraine):

| Request | Result |
|---|---|
| POE E1 schedule, E3 settlements, E4 house status, E5 registry (`www.poe.pl.ua/customs/…`) | **all four: `curl: (28) Connection timed out after 30000 ms`** (no TCP connection at all) |
| ztoe schedule GET, ztoe `all=1` POST, PowerOn `pw_otgs`, PowerOn `pw_accidents` | 200 in 0.2–1.4 s |

The same four POE requests answer at once from Ukraine (200, schedule table, directory, house status, registry; checked 2026-11-18). So `www.poe.pl.ua` drops connections from this non-Ukrainian (datacenter) address, while the Zhytomyr hosts do not. One run is one data point; the probe runs on every iOS push, so later runs show whether it lasts. Consequences:

- **App Review (R1, guideline 2.1).** A reviewer outside Ukraine will most likely see «сайт недоступний» and no schedule. Not solvable in code without a server in Ukraine. To decide before I5: a screen recording made in Ukraine plus an explanation in the review notes (usual for region-locked data), and/or a clearly labelled demo schedule shown only while POE cannot be reached and no data was ever loaded. A relay server in Ukraine is not recommended (cost, privacy: the house number would pass through it).
- **CI live tests (I2).** `LiveFetchTests` cannot reach POE from GitHub-hosted runners. The POE live test prints the result and passes when the host is unreachable from the runner (it still fails on a reachable host with an unparsable answer); the fixture tests carry the parser checks.
- **`poe-data.yml` (Android and web, outside the iOS plan).** The daily probe, the weekly directory crawl and the daily queue-catalogue rebuild run on `ubuntu-latest` too, and have never run yet (the workflow is not on the default branch). They will probably time out in the same way: a self-hosted runner in Ukraine, or running the scripts locally and committing the result, are the alternatives.
