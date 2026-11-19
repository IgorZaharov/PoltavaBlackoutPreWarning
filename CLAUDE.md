# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

"Світло в Полтаві" — the Poltava version of "Світло в Житомирі" (seeded from `IgorZaharov/Android-ZTBlackoutPreWarning` 1.4.0 at `c5573b9`, history kept; remote `upstream`). It shows outage countdowns, a 24h timeline, Glance/WidgetKit widgets and exact pre-warning alarms for 12 queues `1.1`–`6.2` with 48 half-hour slots.

**Read `docs/POLTAVA_PORT_PLAN.md` first.** It holds the owner decisions D1–D9 and the milestones (Android P0–P6, then iOS I0–I5); `spec/POE_API.md` is the data source (Полтаваобленерго, www.poe.pl.ua; recorded answers in `spec/fixtures/poe/`). Status: **P0–P4 done**: Android and the web simulator run on POE data with the POE screens (switching cells, nearby outages card, measures, oblast-wide picker); the Zhytomyr data layer (ztoe, PowerOn) is removed from both. Next is P5 (a week on a real phone). The iOS app (`ios/`) runs on POE data since milestone I2 (`ios/Shared/Data/Poe*.swift`; its P4 screens follow in I3, plan `docs/ios/POLTAVA_IOS_PLAN.md`); `spec/POWERON_API.md` stays only as the inherited reference that other spec files still cite (ledger merge, date horizon, tri-state results). `HANDOVER.md` describes the inherited 1.4.0 architecture (its data-layer sections are historical); read the relevant section before non-trivial changes.

The repo holds **three implementations that must stay in logic/UI/text parity**:
- `android/` — native Kotlin app (Compose M3, Glance widgets, WorkManager, AlarmManager). Kotlin namespace `ua.blackout.prewarning` (kept so upstream fixes merge cleanly); application id `ua.blackout.prewarning.poltava`.
- `src/` — React 19 + TS + Vite web simulator/workbench mirroring the Android logic (`src/services/poeScheduleSync.ts`, `scheduleCache.ts` and `outageRepository.ts` mirror `PoeScheduleSync.kt`, `ScheduleRepository.kt` and `OutageRepository.kt`; `MainView.tsx`/`WidgetSimulator.tsx` mirror `MainScreen.kt`/`TimelineBar.kt`/`BlackoutGlanceWidget.kt`; `i18n.ts` mirrors `AppStrings.kt`). When changing behavior on one side, change the other.
- `ios/` — native SwiftUI app + WidgetKit extension (iOS 17+, built with Xcode 26, XcodeGen `ios/project.yml`), being ported to 1.4.0 milestone by milestone: `docs/ios/IOS_PORT_PLAN.md` is the plan (owner decisions, Liquid Glass with fallback, App Review items, milestones). No roulette anywhere in the Poltava app (owner decision D5, removed from Android and web in P0). Pure Swift core in `ios/Shared/Core/` mirrors `core/*.kt`.

## Commands

Web / Node (root):
```bash
npm install
npm test          # tsx tests/unit.test.ts (invariants + changelog enforcement) and tests/spec-vectors.test.ts (golden vectors + src/core purity gate)
npm run lint      # tsc --noEmit
npm run dev       # Vite on :3000 (/proxy-poe proxies to www.poe.pl.ua)
npm run build
```

Android (JDK 17, compile/target SDK 36, Gradle 8.11.1; run from `android/`):
```bash
gradle testDebugUnitTest
gradle testDebugUnitTest --tests "ua.blackout.prewarning.AppInvariantsTest"
gradle assembleDebug
```
iOS (no Mac needed; CI is the compiler): `.github/workflows/build-ios.yml` runs on `feat/ios-**` / `ios/**` branches, PRs touching `ios/` or `spec/`, and `ios-v*` tags (TestFlight upload). Locally on a Mac: `cd ios && xcodegen generate && xcodebuild test -project SvitloZhytomyr.xcodeproj -scheme ZTPreBlackout -destination 'platform=iOS Simulator,name=iPhone 17'`.

CI (`.github/workflows/build-apk.yml`) runs `npm test`, then Gradle tests, debug/release APK and AAB. The "Publish GitHub Release" step runs on a `v*` tag, **and on every push to `main`/`master`** (and `workflow_dispatch`): never push to `main` casually, work on a branch and open a PR (PR runs build and test but skip the publish step). Release signing falls back to the debug key when the upload-keystore secrets are missing.

## Architecture (Android)

Since 1.4.0 there is one source of truth for "what is off and when": the pure package `core/` (`java.time` only, no Android imports; mirrored in `src/core/*.ts`):

- `OutageEngine` works on a two-day window (yesterday's tail, today, tomorrow) of absolute Kyiv `LocalDateTime`s. Outage kinds PLANNED (POE queue table, `OFF` cells), REPAIR (POE planned works, folded into Planned) and EMERGENCY (POE «пошкодження»). POE's switching half-hour (`SWITCHING` cells) is never part of an outage: `switchWindows` feed `SlotState.switching` and `StatusInfo.restoreUntil` (`spec/OUTAGE_ENGINE.md` 3.5). Overlapping or touching outages merge into spans, so a block over midnight is ONE span with its full duration and ONE alert. Finished spans never alert; an emergency still listed after its estimated end stays active for a 60 minute grace, then goes stale.
- `EmergencyLedger` keeps a per-address record of seen emergencies (POE keeps no history); a failed fetch (`EmergencyFetch.Unavailable`) is never "no outage". Events START / ETA_CHANGED / END feed notifications.
- `StreetKey` / `HouseKey` merge duplicate streets and compare houses (`spec/ADDRESS_KEY.md`).
- `SiteState` (AVAILABLE_WITH_TABLE / AVAILABLE_NO_TABLE / SITE_UNREACHABLE / NO_INTERNET) is shown on the main screen; a failure never clears the cached schedule.

Data flow: `data/poe/` — `PoeScheduleSync` (today + tomorrow tables of all 12 queues through `PoeClient`, parsed by `core/PoeSchedule`, stored as three-state cells by `ScheduleRepository.saveAllCellsBatch`) and the per-house status (`PoeClient.addressStatus` → `core/PoeMapper`: queue, emergency, repair works; `message_type 4` is a schedule mirror, never an emergency) → `OutageRepository` (also writes the queue POE reports for each address back into the subscription store); the address picker uses `PoeAddressLookup` (bundled `assets/poe_directory.json`, houses live) → `OutageRepository` (`refresh()` does the network, `snapshot()` is local only; state in `OutageStateStore` and `ScheduleRepository`) → consumers: Compose UI (`ui/screens`), `AlarmScheduler`/`AlarmReceiver` (one alert per span from `OutageEngine.planAlerts`, today + tomorrow, exact alarms through `ExactAlarmGate`, request codes from `AlarmCodes`), and `BlackoutGlanceWidget`. `ScheduleSyncWorker` (WorkManager) refreshes periodically; `BootCompletedReceiver` reschedules after reboot.

## Spec and parity

`spec/` is the contract between Android, the web simulator and the iOS port. `spec/vectors/*.json` are golden cases run by `SpecVectorsTest.kt` and `tests/spec-vectors.test.ts` and by the iOS XCTest target, which reads `spec/vectors` directly. Change behaviour by editing the spec and a vector first, then both implementations. The iOS app lives in `ios/` (moved from `IgorZaharov/iOS-ZTPreBlackoutNotification`, to be archived); `docs/ios/IOS_HANDOVER_v1.4.0.md` has the file mapping and corrected ids, `docs/ios/IOS_PORT_PLAN.md` the plan. The inherited PowerOn quirks are in `spec/POWERON_API.md` (no code reads PowerOn any more).

## Invariants enforced by tests (do not change unless the owner asks)

Asserted in `tests/unit.test.ts` and `android/app/src/test/.../AppInvariantsTest.kt`:
- App name `"Світло в Полтаві"` (strings.xml, AppStrings.kt, metadata.json, index.html, i18n.ts, iOS `CFBundleName`). Only the iPhone home-screen name (`CFBundleDisplayName`) is the short `"Світло"` (owner, 2026-11-15: the full name is cut there).
- Defaults: `advanceNoticeMinutes = 15`, `refreshIntervalMinutes = 30`.
- Queue help dialog 4-step text and `"Зрозуміло"` button, character-for-character.
- Widget labels `"СВІТЛО Є"` / `"СВІТЛА НЕМАЄ"` (never `"ЗНЕСТРУМЛЕНО"`); widget countdowns without seconds (`HHг. MMхв.`).
- Facebook emergency link `https://www.facebook.com/atpoltavaoblenergo` on the main screen (owner decision D2); donations block reads `/donations.json`.
- Main timeline and big widget must produce identical 48 half-hour states.
- **Changelog enforcement:** any modified file under `ui/`, `components/`, or `widget/` (and `.swift` under `ios/App/UI/` or `ios/Widget/`) must be mentioned by filename in `CHANGELOG.md`, or `npm test` fails.

## Synced / generated files

- `valid-urls.json` and `donations.json` at root are canonical; copies live in `public/`, `android/app/src/main/assets/` and `ios/Resources/`. Keep all four in sync (`npm test` checks it).
- `poe_directory.json` at root (POE address directory snapshot) is canonical; copies live in `public/` and `android/app/src/main/assets/` (iOS from milestone I2), checked by `npm test`. Regenerate with `python -X utf8 scripts/crawl_poe_directory.py <raw.json> --compact poe_directory.json` (about 1 700 requests, one hour); `.github/workflows/poe-data.yml` does it weekly on `main`.
- `poe_queues.json` at root (address and company -> queue, from POE's hourly-schedule PDF; `spec/POE_API.md` 8.11) is built by `python -X utf8 scripts/build_poe_queue_catalogue.py --update` (needs `pip install pymupdf`; rebuilds only when the PDF or `PARSER_VERSION` changed; `--lookup`, `--company`, `--selftest` for checks); `.github/workflows/poe-data.yml` runs it daily and updates the copies in `public/` and `android/app/src/main/assets/` (checked by `npm test`). The apps read it through `PoeQueues.kt` / `src/services/poeQueues.ts` (lookup `core/QueueCatalogue.kt` / `src/core/queueCatalogue.ts`): queues for "several connections" houses, for settlements without streets and streets without houses, and the company search.
- `spec/vectors/poe_*.json` and `outage_engine_poe.json` are generated by `python -X utf8 scripts/gen_poe_vectors.py .` from `spec/fixtures/poe/` (recorded live answers); edit the generator, not the JSON.
- `ios/Shared/AppStrings.swift` is generated from `AppStrings.kt` by `node scripts/ios-strings.cjs` (only its MANUAL block is hand-written); `npm test` fails when it is stale. iOS-only strings go into `AppStrings.kt` first, marked iOS-only.
- `src/data/androidProjectFiles.ts` embeds Android sources for the web code explorer. `scripts/generate_android_project.cjs` refreshes that file from `android/` but **re-creates any file that is missing from `android/` out of its stale TS copy** — delete the entries of removed Android files from the TS data first, and never run it from a state where `android/` is incomplete.
- After changing `android/`, stage the changes and rebuild the downloadable archive: `python scripts/build_android_zip.py` (zips the git-tracked files under `android/` into `public/PoltavaBlackoutPreWarning.zip`, so local build outputs stay out).
- `android/app/keystore/debug.keystore` is intentionally committed (stable signature for in-place upgrades); `versionCode = (GITHUB_RUN_NUMBER ?: 300) + 300`. Do not change `.github/`, the keystore or the signing/`versionCode` blocks without the owner.

## Releasing vX.Y.Z

Bump the version in all of: `android/app/build.gradle.kts` (`versionName`), `ios/project.yml` (`MARKETING_VERSION`), `package.json`, `vite.config.ts`, `AboutScreen.kt`, `src/components/AboutView.tsx`, `CHANGELOG.md` (`## [X.Y.Z] - YYYY-MM-DD`), and the expected version in `tests/unit.test.ts`. Rebuild the zip, run `npm test`, then tag and push.
