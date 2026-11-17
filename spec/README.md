# spec/ — the contract between Android, the web simulator and iOS

Parity between the three clients used to rest on long prose documents. From 1.4.0 it is checked by
machine: every platform runs the same golden cases in `vectors/` and fails when it disagrees.

| File | What it fixes |
|---|---|
| [OUTAGE_ENGINE.md](OUTAGE_ENGINE.md) | Two-day window, outage kinds, statuses, spans across midnight, alerts, widget transitions |
| [POE_API.md](POE_API.md) | **Poltava data source** (Полтаваобленерго): schedule with the switching half-hour, address directory, per-house status («пошкодження» = emergency), branch registry, mapping rules |
| [fixtures/poe/](fixtures/poe/) | Recorded live POE answers (2026-11-16), shared by the vector runners and the client tests of all platforms |
| [branches.json](branches.json) | The 28 POE branches with their two id spaces (`cabinetId` for addresses, `registryId` for the outage registry) |
| [POWERON_API.md](POWERON_API.md) | Inherited Zhytomyr emergency source (used until P2 replaces it): endpoints, filters that work, the `+00:00` timestamp quirk, pagination |
| [ADDRESS_KEY.md](ADDRESS_KEY.md) | `StreetKey` / `HouseKey`: how duplicate streets are merged and houses compared |
| [SITE_STATE.md](SITE_STATE.md) | The four ztoe site states and how a fetch result maps to one |
| [NOTIFICATIONS.md](NOTIFICATIONS.md) | Planned and emergency alert events, keys, channels, gating |
| [UI_DRUM.md](UI_DRUM.md) | Drum chart cell states, emergency stripes, widget bitmap |
| [PERSISTENCE.md](PERSISTENCE.md) | Field names, types and defaults every platform stores |
| [ONBOARDING.md](ONBOARDING.md) | First-run tour: steps, what is lit, tip placement, when it ends |
| [SUBSCRIPTIONS.md](SUBSCRIPTIONS.md) | Multi-address store (step 1): model, repair, operations, migration from single-address settings |
| [config.json](config.json) | Shared constants (grace, TTLs, timeouts, defaults) |
| [rems.json](rems.json) | The 19 REMs with ztoe `rem_id` and PowerOn `otg.id` (two different id spaces) |
| [design-tokens.json](design-tokens.json) | Colours, radii, type roles |
| [vectors/](vectors/) | Golden input → expected output cases |

## Who runs the vectors

| Platform | Runner | Command |
|---|---|---|
| Android | `android/app/src/test/.../core/SpecVectorsTest.kt` | `cd android && gradle testDebugUnitTest` |
| Web | `tests/spec-vectors.test.ts` (also gates that `src/core/` imports nothing from the DOM, React or services) | `npm test` |
| iOS | `ios/Tests/SpecVectorsTests.swift` reading the same JSON files by name | in the iOS build (`build-ios.yml`) |

The POE files `poe_api.json`, `outage_engine_poe.json` and `poe_schedule.json` run on Android and the web from P1/P2; the iOS target picks them up in milestone I1 of `docs/POLTAVA_PORT_PLAN.md` (it loads vector files by name, so new files do not break it before that).

CI already runs both of the first two (`npm test`, then Gradle tests), so a vector can not be skipped
on one side.

## Changing behaviour

1. Change the prose here and add or edit a vector first.
2. Make Kotlin and TypeScript pass it. A vector that only one side passes is a bug in the spec or in
   that side, never a reason to skip it.
3. Mention the change in `CHANGELOG.md`; the iOS port reads the vectors and the changelog.

## Time

Every instant is a `LocalDateTime` in `Europe/Kyiv`. PowerOn labels its local times `+00:00`; the
offset is dropped (POWERON_API.md, vector `poweron_api.json`). A default Swift `ISO8601DateFormatter`
would apply the offset and be two to three hours wrong.
