# App Review notes: «Світло в Полтаві» for iPhone

Text for the **App Review Information → Notes** field in App Store Connect (milestone I5 of
`POLTAVA_IOS_PLAN.md`). The field takes about 4000 characters, so paste the English block below unchanged.
The Ukrainian block is for the owner and is not pasted.

**Owner decision 3 (2026-11-19):** the power company's website does not answer requests from outside
Ukraine (geo-check, `POLTAVA_IOS_PLAN.md` section 9), so the reviewer will most likely see «сайт
недоступний» and no schedule. We answer with **a screen recording made in Ukraine, attached to the
submission, and this note**. No demo or fake schedule is built into the app.

Before each submission, check the facts marked ⟳. They can change between versions.

## The screen recording (owner, before each submission that changes the screens)

Record on the iPhone itself (Control Center → Screen Recording), in Ukraine, on a day with outages,
portrait, 1 to 3 minutes, no sound needed. Show in this order:

1. The app opening on the main page with an address: status, countdown, the 24-hour timeline with the
   red outage cells (and a yellow switching half-hour if the day has one), the list of today's outages.
2. Settings → «Мої адреси» → add an address with «?»: branch, settlement Полтава, a street, a house; the
   queue that the website reports for that house.
3. Settings → «Тест сповіщення»: the notification arriving.
4. The home screen with the widgets (small, medium, large, «Графік»), and one tap on the widget's refresh
   button.
5. If it happens on the day: a real pre-warning notification or an emergency outage on the main page.

Attach the file in **App Store Connect → the version → App Review Information → Attachment**, and keep a
copy in a public place you control (for example an unlisted video), whose link replaces ⟳RECORDING_LINK
below. Never show your own house number in a recording: pick a public building (the city council at
вул. Соборності, 36, for example).

## English (paste into App Store Connect)

```
WHAT THE APP DOES
"Світло в Полтаві" ("Power in Poltava") shows the public power-outage schedule of the Poltava region of Ukraine and warns the user before an outage starts. Ukraine has rolling blackouts; the regional power company publishes which group ("queue", 1.1 to 6.2) is switched off in which half-hour of the day. The app reads that table, shows a countdown, a 24-hour timeline and home-screen widgets, and schedules local notifications. For a saved address it also shows emergency outages and planned repair works reported for that house.

IMPORTANT: THE DATA SOURCE ANSWERS ONLY FROM UKRAINE
The power company's website (www.poe.pl.ua) does not accept connections from outside Ukraine. ⟳ Our automatic check from a server in the United States times out on every build, while the same requests answer at once from Ukraine. So during review the app will most likely show "Сайт POE недоступний, інтернет є" ("POE site unreachable, your internet works") and no schedule. This is the app's normal, honest state when the source cannot be reached: it never invents a schedule and never deletes a schedule it has already downloaded.
A screen recording made in Ukraine on a day with outages is attached to this submission. It shows the main page, choosing an address, a test notification and the widgets. ⟳ Also at: RECORDING_LINK

NOT AN OFFICIAL APP
The app is a free, open-source community project. It is not made by, endorsed by, or affiliated with JSC "Poltavaoblenergo". It does not use the company's logo. The disclaimer is shown on the main page and in About. Source code: https://github.com/IgorZaharov/PoltavaBlackoutPreWarning

DATA SOURCE (public, no login, no API key)
https://www.poe.pl.ua - the power company's public outage pages; the app calls the same public endpoints those pages use (/customs/...).

HOW TO TEST WITHOUT THE SOURCE (no account needed)
1. Tap "Виберіть чергу" / "Select queue" on the first page. A short tour points to the controls; tap to go on.
2. Choose any queue, for example 1.1. In the address search ("?") settlements and streets are built in; the houses of a street come from the website.
3. The main page shows the queue, the website state and, once the source answers, the countdown, the timeline for today and tomorrow and the outages. All times are Kyiv time. The dock at the bottom (or a swipe) opens Settings and About.
4. Notifications: after a queue is chosen, a card on the main page asks for permission. Settings has a "Тест сповіщення" / "Test notification" button that sends one at once; this works without the source.
5. Widgets: add "Світло в Полтаві" from the home-screen widget gallery (small, medium, large, and the "Графік" timeline widget). Long-press a widget and choose "Edit Widget" to pick which saved address it shows. On the widgets the bell turns all warnings on or off and the arrow reloads the data, without opening the app.

BACKGROUND
Warnings for the published schedule are scheduled as local calendar notifications, so they arrive with the app closed. Background App Refresh (BGAppRefreshTask) only fetches updates; iOS decides how often. The only background mode is "fetch". There is no push server.

PRIVACY
No account, no analytics, no advertising, no tracking; the developer has no server. Saved addresses stay on the device. To get the status of a saved house, the app sends the public ids of its settlement and street and the house number directly to the power company's website, the same input its own search form takes. Privacy policy (iPhone): ⟳ https://github.com/IgorZaharov/PoltavaBlackoutPreWarning/blob/main/PRIVACY_POLICY_IOS.md

DONATION LINKS (About page)
⟳ The About page lists links to Ukrainian charities (animal volunteers, the "Come Back Alive" foundation). They are plain links that open in Safari. The app does not collect money and has no in-app purchases; it is free and stays free.

CONTACT
Issues: https://github.com/IgorZaharov/PoltavaBlackoutPreWarning/issues
```

## Українською (для власника, не вставляти)

- **Що робить:** показує публічний графік погодинних відключень Полтавщини й попереджає до початку відключення: таймер, шкала доби, віджети, локальні сповіщення; для адреси ще аварійні відключення й ремонти за даними сайту.
- **Головне для перевірки:** сайт `www.poe.pl.ua` не відповідає на запити з-за кордону, тож рецензент, найімовірніше, побачить «Сайт POE недоступний, інтернет є». Тому до заявки додається запис екрана, зроблений в Україні (вимоги вище), і пояснення в нотатці. Демо-графіка в застосунку немає (рішення власника 3).
- **Неофіційний:** відкритий безкоштовний проєкт, не пов'язаний з АТ «Полтаваобленерго», без логотипа компанії. Застереження є на головному екрані та в «Про застосунок».
- **Як перевірити без джерела:** вибрати чергу (наприклад 1.1); «Тест сповіщення» в налаштуваннях; віджети з галереї віджетів, вибір адреси через «Редагувати віджет».
- **Фон:** попередження за графіком заплановані як локальні сповіщення; фонове оновлення лише підтягує зміни, частоту визначає iOS; push-сервера немає.
- **Приватність:** номер будинку йде лише на сайт обленерго, напряму з iPhone; розробник нічого не отримує.
- **Пожертви:** звичайні посилання, що відкриваються в Safari; покупок у застосунку немає.

## If Review asks questions or rejects

| Reason | Answer or change |
|---|---|
| 2.1 (app looks empty, "could not load data") | Expected outside Ukraine. Point to the attached recording and the paragraph "THE DATA SOURCE ANSWERS ONLY FROM UKRAINE". If Review insists on seeing live data, offer a call or a new recording; a relay server in Ukraine is not planned (cost, and the house number would pass through it). A labelled demo schedule shown only while the source was never reached is the fallback, and needs the owner's OK (it is not built). |
| 5.2.1 / 5.2.2 (the utility's name or content) | Point to the disclaimer and to the public data source. The app copies no text or logo from the site; it shows the schedule as times and colours. If Review asks for permission from the company, ask the owner first; there is no such letter today. |
| 5.1.1 (privacy) | The policy names the website and that the house number goes to it (section 4). "Data Not Collected" stands: the developer receives nothing, and the request goes to the utility to answer for that house. |
| 3.2.2 (donations) | The links open in Safari and the app takes no money. If Review still objects, the fallback is to hide the donations block on iOS only (`IOS_PORT_PLAN.md` section 9, question 1). |
| 4.2 (minimum functionality) | Name the native features: widgets with their own address, interactive widget buttons, local notifications at the exact minute, emergency outages per address, background refresh. |
