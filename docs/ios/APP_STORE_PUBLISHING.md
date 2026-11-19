# Publishing «Світло в Полтаві» on the App Store

Milestone I5 of `POLTAVA_IOS_PLAN.md`. Follow the steps in order in App Store Connect
(https://appstoreconnect.apple.com). Every field has the value to enter. Ukrainian is the primary
language of the listing, English is the second localization.

Status on 2026-11-19: I0–I4 are merged into `feat/ios-i1-core`, and CI builds and tests the app. Nothing exists on the
Apple side yet: no App IDs, no app record, no repository secrets, no TestFlight build. Rewritten from the
Zhytomyr guide (`IgorZaharov/Android-ZTBlackoutPreWarning`), whose app is already on the store.

---

## 0. Before you start: blockers

Fix these first. Each one is a likely rejection or a step you cannot finish.

| # | Problem | What to do |
|---|---|---|
| B1 | **This repository has no `main` branch** (the default branch is `feat/p0-seed-rebrand`). The app and this guide link to `…/blob/main/PRIVACY_POLICY_IOS.md`, and the app downloads `donations.json`, `poe_directory.json` and `poe_queues.json` from `raw.githubusercontent.com/…/main/…`. Today all of them are 404: App Review opens the privacy link and finds nothing (guideline 5.1.1), and the About donations and the directory refresh fail quietly (Android too). | Owner: create `main` from the merged work before submitting. A push to `main` also publishes an Android GitHub release (`build-apk.yml`), so do it as the P6 v1.0.0 release, with the iOS branch merged in first. Not needed for TestFlight. |
| B2 | **Nothing is set up at Apple.** CI can neither sign nor upload. | Section 1: App IDs, App Group, app record, API key, the four repository secrets. |
| B3 | **POE answers only from Ukraine** (`POLTAVA_IOS_PLAN.md` section 9), so the reviewer sees «Сайт POE недоступний, інтернет є» and no schedule. | Owner decision 3 (2026-11-19): a screen recording made in Ukraine, attached in 5.9, plus the note in `APP_REVIEW_NOTES.md`. |
| B4 | **Support URL.** Apple requires a page where users can contact you. | Use the GitHub Issues page (5.5). Optional: a contact e-mail in the README for users without a GitHub account. |
| B5 | **Countries.** | Answer in section 3 (recommendation: all countries except mainland China). |
| B6 | **EU trader status (Digital Services Act).** Without an answer the app is not offered in the EU. | Answer in 2.6. |

---

## 1. Apple setup and the first TestFlight build

### 1.1 Identifiers (https://developer.apple.com → Certificates, Identifiers & Profiles), same team as the Zhytomyr app

1. **Identifiers → + → App Groups:** `group.ua.blackout.prewarning.poltava`.
2. **Identifiers → + → App IDs → App**, explicit Bundle ID `ua.blackout.prewarning.poltava`, capability
   **App Groups** → Configure → the group above.
3. The same for `ua.blackout.prewarning.poltava.widget`, with the same group.
4. **Devices:** at least one registered iPhone (the archive's automatic signing needs one). The phone used
   for the Zhytomyr TestFlight builds is already there.

No other capability: the entitlements hold only the App Group, and background refresh is an `Info.plist`
key.

### 1.2 App record (App Store Connect → Apps → + → New App)

| Field | Value |
|---|---|
| Platform | iOS |
| Name | `Світло в Полтаві` |
| Primary Language | **Ukrainian** (it decides which localization the store shows by default outside the listed languages) |
| Bundle ID | `ua.blackout.prewarning.poltava` |
| SKU | `svitlo-poltava-ios` (any unique text) |
| User Access | Full Access |

### 1.3 API key and repository secrets

App Store Connect → Users and Access → Integrations → App Store Connect API → **Team Keys**. Reuse the
Zhytomyr key if you still have its `.p8` file (same team); otherwise **+**, name `GitHub CI`, access
**Admin** (cloud signing creates the profiles), and download the `.p8`. Apple allows only one download.

Set the four secrets yourself. The command prompts for each value; paste it there:

```bash
gh secret set APPLE_TEAM_ID --repo IgorZaharov/PoltavaBlackoutPreWarning
```
```bash
gh secret set ASC_KEY_ID --repo IgorZaharov/PoltavaBlackoutPreWarning
```
```bash
gh secret set ASC_ISSUER_ID --repo IgorZaharov/PoltavaBlackoutPreWarning
```
```bash
gh secret set ASC_KEY_P8 --repo IgorZaharov/PoltavaBlackoutPreWarning < AuthKey_XXXXXXXXXX.p8
```

Team ID: developer.apple.com → Membership details. Key ID: the key's row. Issuer ID: above the key table.

### 1.4 Upload and install

1. Tag the iOS branch: `ios-v1.0.0-N` (N counts up from 1) on `feat/ios-i1-core`, push the tag. The
   `testflight` job of `build-ios.yml` runs after the tests and uploads; the build number is the CI run
   number. A missing secret fails the job at once in «Check signing secrets».
2. App Store Connect processes the build (10 to 30 minutes). No export-compliance question:
   `ITSAppUsesNonExemptEncryption = NO` is in `Info.plist`.
3. **TestFlight → Internal Testing → +**: a group with yourself, add the build. On the iPhone: the
   TestFlight app, same Apple ID, accept, install. It installs next to the Zhytomyr app (own identifiers).
4. Device checks: section 7 of `POLTAVA_IOS_PLAN.md`, the I4 row (alert with the app killed, background
   run, tap opening its address, widgets in the tinted and clear styles).

---

## 2. App Information (General → App Information)

### 2.1 Localizable information

Switch the language in the top-right menu. Add **English (U.S.)** with **+ Add Language** if it is missing.

| Field (limit) | Ukrainian | English (U.S.) |
|---|---|---|
| Name (30) | `Світло в Полтаві` | `Світло в Полтаві` |
| Subtitle (30) | `Графік відключень світла` | `Poltava power outage times` |

- The name is a test invariant; keep it in Cyrillic in both languages.
- Do **not** put "POE" or "Полтаваобленерго" in the name, subtitle or keywords. The company's name in
  metadata reads as an official app (guidelines 2.3.7, 5.2.1). It appears only in the description as a
  disclaimer.

### 2.2 General information

| Field | Value |
|---|---|
| Category, Primary | **Utilities** |
| Category, Secondary | **Lifestyle** (optional; leave empty if unsure) |
| Content Rights | **Yes**, the app contains, shows or accesses third-party content, and **Yes**, you have the necessary rights. Reason: the schedule and the outage lists are public factual information from the company's open pages; the app copies no text, logo or images. |

### 2.3 Age Rating (Edit)

Answer every question with **None** or **No**:

| Section | Answer |
|---|---|
| In-app controls: parental controls, age assurance | No |
| Capabilities: unrestricted web access | **No** (links open in Safari, there is no in-app browser) |
| Capabilities: user-generated content, messaging or chat, advertising | No |
| Mature themes (profanity, horror, alcohol/drugs, mature themes) | None |
| Medical or wellness topics | None |
| Sexuality or nudity | None |
| Violence | None |
| Chance-based activities (simulated gambling, contests, loot boxes) | None / No (no roulette in the Poltava app, owner decision D5) |
| Made for Kids | No |

Expected result: **4+**.

### 2.4 License Agreement

Leave the **Apple Standard License Agreement (EULA)**.

### 2.5 App Encryption Documentation

Nothing to do (see 1.4).

### 2.6 Digital Services Act (Business → Agreements / App Information → "Trader Status")

The question: are you a trader? A free app with no income, no ads and no purchases, made by a private
person, is usually **"I am not a trader"**. Then nothing is published about you, and the app is still
available in the EU. If you answer "trader", Apple shows your address, phone and e-mail on the EU
product page. This is a legal declaration; it is your call. If you answered it for the Zhytomyr app, the
answer is per account and may already apply.

---

## 3. Pricing and Availability

| Field | Value |
|---|---|
| Price | **Free** (USD 0.00) |
| Availability | **All countries or regions**, then **untick China mainland** (it needs an ICP filing number). Recommended because many people outside Ukraine watch their family's address; the data then loads only on a phone in Ukraine, which the description says. Optional: untick Russia and Belarus. |
| Pre-Orders | Off |
| App Distribution Methods | **Public** |
| iPhone and iPad Apps on Apple Silicon Macs | **Untick** "Make this app available". Widgets, background refresh and notifications were tested only on iPhone. |
| Apple Vision Pro | **Untick**. |
| Tax Category | Leave the default ("App Store software"). |

No Paid Apps agreement, no bank or tax forms are needed for a free app.

---

## 4. App Privacy (General → App Privacy)

| Field | Value |
|---|---|
| Privacy Policy URL | `https://github.com/IgorZaharov/PoltavaBlackoutPreWarning/blob/main/PRIVACY_POLICY_IOS.md` (works once B1 is done; iPhone only, the Android policy stays in `PRIVACY_POLICY.md`) |
| User Privacy Choices URL | empty |
| Data collection | **Get Started → "No, we do not collect data from this app"** → Save → **Publish**. |

Why "No": Apple counts data as collected when it leaves the device and you or a partner keep it longer
than needed to answer the request. The app has no server of its own, no SDKs and no analytics. The
settlement and street ids and the house number go from the iPhone straight to the power company's public
website, only so that it answers for that house; the developer receives nothing, and the company is not
the developer's partner. The policy says so in section 4. This matches `PrivacyInfo.xcprivacy`
(`NSPrivacyCollectedDataTypes` is empty, `NSPrivacyTracking` is false). The product page will show
**"Data Not Collected"**.

---

## 5. Version page (iOS App → 1.0.0 Prepare for Submission)

The version must equal `MARKETING_VERSION` in `ios/project.yml` (`1.0.0`, owner decision D7). If the left
column shows "1.0", change **Version** to `1.0.0`.

### 5.1 Screenshots

Source: GitHub Actions → latest green **iOS build, tests and TestFlight** run on `feat/ios-i1-core` (or
`main` after B1) → artifacts `ios-appstore-6.9` (1320 × 2868) and `ios-appstore-6.5` (1284 × 2778), each
with `uk/` and `en/`.

| Language | 6.9" Display | 6.5" Display |
|---|---|---|
| Ukrainian | files from `ios-appstore-6.9/uk` | optional: `ios-appstore-6.5/uk` |
| English (U.S.) | files from `ios-appstore-6.9/en` | optional: `ios-appstore-6.5/en` |

- Only the 6.9" set is required; Apple scales it for smaller iPhones. Up to 10 images, drag to order;
  put the main page first, then the widgets.
- No iPad screenshots: the app is iPhone only (`TARGETED_DEVICE_FAMILY = 1`).
- App Preview video: optional, skip.
- **Check the set before uploading.** CI runs outside Ukraine, where POE does not answer, so its
  screenshots of the main page may show the unreachable state and an empty drum. Upload only images
  with a schedule on the drum. If the CI set has none, take the screenshots on the iPhone in Ukraine
  (6.9": iPhone 16/17 Pro Max class; any iPhone's screenshots can be used if one size class is
  missing) and never show your own house number.

### 5.2 Promotional Text (170, can change any time without review)

Ukrainian:
```
Графік відключень світла на Полтавщині: таймер, шкала доби, віджети й попередження до початку відключення. Безкоштовно, без реклами.
```

English:
```
Power outage schedule for the Poltava region: countdown, 24-hour timeline, widgets and a warning before the power goes off. Free, no ads.
```

### 5.3 Description (4000)

Ukrainian:
```
«Світло в Полтаві» показує графік погодинних відключень електроенергії на Полтавщині й попереджає заздалегідь, щоб ви встигли зарядити телефон, зварити обід чи дістатися додому до того, як зникне світло.

ЩО ВМІЄ ЗАСТОСУНОК
• Черга або адреса. Виберіть свою чергу (від 1.1 до 6.2) або знайдіть її за адресою: філія, населений пункт, вулиця, будинок. Пошук населеного пункту працює по всій області; можна шукати й за назвою підприємства.
• До п'яти адрес. Дім, робота, батьки: у кожної адреси своя черга і свої сповіщення.
• Таймер до наступного вимкнення або увімкнення. Для півгодини перемикання показано, до котрої світло повернеться.
• Шкала доби на сьогодні й завтра: 48 півгодинних проміжків, одразу видно, коли світла не буде.
• Аварійні відключення («пошкодження») і планові ремонти для вашого будинку з орієнтовним часом відновлення.
• «Ремонти й пошкодження поруч»: відключення на вашій вулиці за сьогодні.
• Попередження за 15 хвилин (або за вибраний вами час) до початку відключення, навіть коли застосунок закритий.
• Віджети на головний екран: малий, середній, великий і «Графік». Кожен віджет може показувати свою адресу, а кнопки дзвіночка й оновлення працюють прямо у віджеті.
• Стан сайту обленерго. Якщо сайт недоступний, застосунок показує останній збережений графік.
• Українська та англійська мови.

ПРИВАТНІСТЬ
Без реєстрації, без реклами, без аналітики і без відстеження. Адреси зберігаються лише на вашому iPhone; запити йдуть просто на сайт обленерго.

ВАЖЛИВО
Це неофіційний безкоштовний застосунок з відкритим кодом. Він не пов'язаний з АТ «Полтаваобленерго». Дані беруться з публічних сторінок відключень сайту poe.pl.ua, який відповідає лише на запити з України. Остаточну інформацію перевіряйте на офіційному сайті обленерго.
```

English:
```
"Світло в Полтаві" ("Power in Poltava") shows the rolling power-outage schedule of the Poltava region of Ukraine and warns you in advance, so you can charge your phone, cook or get home before the power goes off.

FEATURES
• Queue or address. Pick your queue (1.1 to 6.2) or find it by address: branch, settlement, street, house. The settlement search covers the whole region; you can also search by the name of a workplace.
• Up to five addresses. Home, work, parents: each address has its own queue and its own warnings.
• Countdown to the next outage or to the power coming back. For the switching half-hour the app shows by when the power is back.
• 24-hour timeline for today and tomorrow: 48 half-hour slots show at a glance when there is no power.
• Emergency outages and planned repair works for your house, with the estimated restore time.
• "Repairs and damage nearby": today's outages on your street.
• A warning 15 minutes (or the time you choose) before an outage starts, even when the app is closed.
• Home-screen widgets: small, medium, large and "Графік" (timeline). Each widget can show its own address; the bell and refresh buttons work right in the widget.
• Status of the power company's site. When the site is down, the app shows the last saved schedule.
• Ukrainian and English.

PRIVACY
No account, no ads, no analytics, no tracking. Your addresses stay on your iPhone; requests go straight to the power company's website.

PLEASE NOTE
This is an unofficial, free, open-source app. It is not affiliated with JSC "Poltavaoblenergo". The data comes from the public outage pages of poe.pl.ua, which answers only requests from Ukraine. Always check the official site for the final information.
```

### 5.4 Keywords (100, comma-separated, no spaces after commas)

Words from the name and subtitle are indexed already; do not repeat them.

Ukrainian:
```
розклад,відключення,електроенергія,черга,блекаут,кременчук,миргород,лубни,горішні плавні,таймер
```

English:
```
power,outage,blackout,schedule,electricity,ukraine,poltava,kremenchuk,queue,alert,widget,svitlo
```

### 5.5 URLs (per language, same values)

| Field | Value |
|---|---|
| Support URL | `https://github.com/IgorZaharov/PoltavaBlackoutPreWarning/issues` |
| Marketing URL (optional) | `https://github.com/IgorZaharov/PoltavaBlackoutPreWarning` |

### 5.6 General

| Field | Value |
|---|---|
| Version | `1.0.0` |
| Copyright | `2026 Igor Zaharov` |
| Routing App Coverage File | none (not a navigation app) |

### 5.7 Build

**Build → + (Add Build)** → pick the TestFlight build you checked on the iPhone (the number is the CI
run number shown in TestFlight). It must be "Ready to Submit"; no export-compliance question appears.

### 5.8 Game Center

Off.

### 5.9 App Review Information

| Field | Value |
|---|---|
| Sign-in required | **Unticked** (no account in the app) |
| Contact: first name, last name | your name |
| Contact: phone | your phone in international form, `+380…` (Apple calls it only if something blocks the review) |
| Contact: e-mail | an address you read daily; review messages also come to the Apple ID |
| Notes | paste the English block from `docs/ios/APP_REVIEW_NOTES.md` without changes. Check the ⟳ facts first and replace `RECORDING_LINK`. |
| Attachment | **Required for this app** (B3): the screen recording made in Ukraine, as described in `APP_REVIEW_NOTES.md`. |

### 5.10 Version Release

Pick **Manually release this version**. After approval you press **Release This Version** when you are
ready (for example together with the Android v1.0.0 release of P6). Phased release is offered only for
updates.

---

## 6. Submit

1. **Save** on the version page. Fix every red field the page lists.
2. **Add for Review** (top right) → the submission sheet lists the version → **Submit to App Review**.
3. Status: Waiting for Review → In Review → Pending Developer Release (manual release) or Ready for
   Distribution. Review usually takes 1 to 2 days; the first review of a new app can take longer.
4. Answer questions in **App Review → Messages** (the Resolution Center). Use the table at the end of
   `APP_REVIEW_NOTES.md` for the likely ones; a 2.1 "no data" question is the most likely.

---

## 7. After approval

1. **Release This Version** (manual release), then check the product page in the App Store app on the
   iPhone (it can take a few hours to appear in search).
2. Mark I5 done in `POLTAVA_IOS_PLAN.md`; record the date and build number.
3. Later updates: bump `MARKETING_VERSION` with the rest of the release checklist in `CLAUDE.md`, tag
   `ios-vX.Y.Z-N` (CI uploads to TestFlight), create the new version in App Store Connect with
   **+ Version or Platform**, fill only **What's New in This Version** (from `CHANGELOG.md`), pick the
   build, submit. Turn on **Phased Release** for updates.

## 8. If App Review rejects

See the table "If Review asks questions or rejects" in `APP_REVIEW_NOTES.md`. Reply in the Resolution
Center first; change code only when the reply does not settle it. A rejected build is not lost: fix,
upload a new build, choose it on the same version page and submit again.
