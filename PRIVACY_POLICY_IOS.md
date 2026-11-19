# Privacy Policy for iPhone / Політика конфіденційності для iPhone

**Application:** Світло в Полтаві (iPhone and its home-screen widgets)  
**Bundle Identifier:** `ua.blackout.prewarning.poltava` (widget extension `ua.blackout.prewarning.poltava.widget`)  
**Platform:** iOS 17.0 or newer, distributed through the Apple App Store  
**Developer:** Igor Zaharov  
**Effective Date:** November 19, 2026  
**Last Updated:** November 19, 2026  
**Contact:** [GitHub Issues](https://github.com/IgorZaharov/PoltavaBlackoutPreWarning/issues)  
**Source code:** [github.com/IgorZaharov/PoltavaBlackoutPreWarning](https://github.com/IgorZaharov/PoltavaBlackoutPreWarning)

This policy covers only the iPhone app. The Android app has its own policy in
[PRIVACY_POLICY.md](PRIVACY_POLICY.md).

Українська версія нижче.

---

## 1. Summary

- The app does **not collect** personal data. There is no account, no sign-in, no advertising, no analytics, no crash-reporting service and no tracking. The developer has no server.
- Your saved addresses and settings stay **on your iPhone**.
- To show the schedule and emergency outages, the app asks the public website of the regional power company, **www.poe.pl.ua**, directly from your iPhone. For the status of your house it sends the public codes of your settlement and street **and the house number** to that website, the same three things you would type into its own search form. Nothing is sent to the developer.
- The App Store label of this app is **"Data Not Collected"**.

The app is a free, open-source community project. It is not made by, endorsed by or affiliated with JSC "Poltavaoblenergo" (АТ «Полтаваобленерго»).

## 2. Data the app does not collect

The app does not collect, store on a server, sell or share:

- names, e-mail addresses, phone numbers or any contact details;
- location (the app never asks for GPS or any location permission; an address is chosen from lists);
- contacts, photos, camera, microphone, Bluetooth, health or fitness data;
- the advertising identifier (IDFA) or any other device identifier;
- usage statistics, diagnostics or crash reports.

The app does not track you across apps or websites, so it never shows the App Tracking Transparency prompt. It contains no third-party SDKs.

## 3. Data kept only on your iPhone

The app keeps these on the device, inside its own sandbox and the App Group container `group.ua.blackout.prewarning.poltava`, which only the app and its own widgets can read:

1. **Saved addresses or queues** (up to five): branch (філія), settlement, street, house number, the queue found for it (1.1 to 6.2), an optional custom name, and the notification switches for each.
2. **Settings:** warning lead time, notification sound, refresh interval, language.
3. **Cache:** the last downloaded schedule of all queues, the emergency outages and repair works last seen for each saved address, the outages listed for the address's settlement, and the house lists already looked up, so the app and widgets work without a connection.
4. **Reference lists:** the list of settlements and streets of the Poltava region and the address-to-queue catalogue. Both ship with the app and can be refreshed from this project's GitHub repository (section 4).

The cache files are excluded from iCloud and device backups. The developer never receives any of this data.

## 4. Network connections

The app connects over HTTPS only to:

| Host | Why | What is sent |
|---|---|---|
| `www.poe.pl.ua` (the public pages under `/customs/` that the company's own outage pages use) | The queue schedule for today and tomorrow; active power-saving measures; the houses of a street; the status of your house (its queue, an emergency outage, planned repair works); the outages listed for your branch | For the schedule and the measures: only the date. For the house list: the public ids of the branch, settlement and street. For the status of a house: the public ids of the settlement and street **and the house number** of each saved address. For the branch list: the branch id and the date. No name, no device identifier, no cookie. |
| `raw.githubusercontent.com` (this project's public repository) | Newer copies of the settlement and street list and the address-to-queue catalogue (at most once a week, or when you tap the refresh button in the address picker), and the donation links of the About page (`donations.json`) | Plain file requests. |
| `icons.duckduckgo.com` and the donation websites (`/favicon.ico`) | Show the small website icon next to each donation link | Only the donation website's domain name. |

As with any internet request, the operators of these servers can see your IP address. The developer does not receive, store or combine it with anything. The house number goes only to the power company's website, which needs it to answer for your house, and the app sends it nowhere else.

## 5. iPhone permissions and system features

| Feature | Why it is used |
|---|---|
| **Notifications** | Local warnings before a planned outage and about emergency outages. The app asks only after you choose a queue or an address, and works fully without permission. All notifications are created on the iPhone; there is no push server. |
| **Background App Refresh** (`fetch`) | Updates the schedule and the status of your addresses from time to time while the app is closed, so warnings and widgets stay current. iOS decides how often; you can turn it off in iOS Settings. |
| **Widgets and App Group** | Share the saved addresses and the cached schedule between the app and its widgets. The widget buttons (bell, refresh) run on the iPhone. |

The app's privacy manifest (`PrivacyInfo.xcprivacy`, app and widget) declares no tracking, no tracking domains, no collected data types, and one required-reason API: `UserDefaults` (reasons `CA92.1` and `1C8F.1`, for the app's own settings and its App Group).

## 6. Links to other services

The app has links to the power company's website and its Facebook page, to donation pages (a Monobank charity jar and the "Come Back Alive" foundation) and to this project on GitHub. They open in Safari, outside the app. The app takes no payments and receives nothing about what you do on those sites. Their own privacy policies apply there.

## 7. Children

The app is a general-audience utility with no account, no chat, no user content and no advertising. It collects no data from anyone, including children.

## 8. Deleting your data

All data is on your iPhone, so you are in control:

- **Settings → reset button** in the app removes the saved addresses and settings;
- **deleting the app** removes it together with its widgets and all App Group data.

There is nothing to delete on the developer's side, because nothing is stored there.

## 9. Your rights

The app processes no personal data on any server of the developer. The rights of access, correction and erasure under the GDPR (EU) 2016/679 and the Law of Ukraine "On Protection of Personal Data" are exercised directly on the device, as described in section 8. For what the power company's website does with its requests, see the policies of JSC "Poltavaoblenergo".

## 10. Changes

Changes to this policy are published in this file with a new "Last Updated" date. The full history is in the public repository.

## 11. Contact

Questions about this policy: [github.com/IgorZaharov/PoltavaBlackoutPreWarning/issues](https://github.com/IgorZaharov/PoltavaBlackoutPreWarning/issues)

---

# Політика конфіденційності для iPhone

**Застосунок:** Світло в Полтаві (iPhone і віджети головного екрана)  
**Ідентифікатор (Bundle ID):** `ua.blackout.prewarning.poltava` (віджет `ua.blackout.prewarning.poltava.widget`)  
**Платформа:** iOS 17.0 або новіша, App Store  
**Розробник:** Ігор Захаров (Igor Zaharov)  
**Набирає чинності:** 19 листопада 2026 року  
**Останнє оновлення:** 19 листопада 2026 року  
**Контакт:** [GitHub Issues](https://github.com/IgorZaharov/PoltavaBlackoutPreWarning/issues)

Ця політика стосується лише застосунку для iPhone. Для Android діє [PRIVACY_POLICY.md](PRIVACY_POLICY.md).

### 1. Коротко

- Застосунок **не збирає** персональних даних. Немає облікового запису, входу, реклами, аналітики, служби звітів про збої та відстеження. Сервера розробника немає.
- Збережені адреси й налаштування залишаються **на вашому iPhone**.
- Щоб показати графік і аварійні відключення, застосунок звертається просто з iPhone до публічного сайту обленерго **www.poe.pl.ua**. Щоб дізнатися стан вашого будинку, він надсилає цьому сайту публічні коди населеного пункту й вулиці **та номер будинку**, тобто те саме, що ви вводите в пошук на самому сайті. Розробникові нічого не надсилається.
- Позначка застосунку в App Store: **«Дані не збираються»**.

Це безкоштовний неофіційний застосунок з відкритим кодом. Він не створений, не схвалений і не пов'язаний з АТ «Полтаваобленерго».

### 2. Що застосунок не збирає

Імена, e-mail, номери телефонів, геопозицію (дозвіл на геопозицію не запитується, адресу вибирають зі списків), контакти, фото, камеру, мікрофон, Bluetooth, дані здоров'я, рекламний ідентифікатор (IDFA) чи інші ідентифікатори пристрою, статистику використання, діагностику та звіти про збої. Застосунок не відстежує вас в інших застосунках і на сайтах і не містить сторонніх SDK.

### 3. Що зберігається лише на iPhone

У пісочниці застосунку та в контейнері App Group `group.ua.blackout.prewarning.poltava`, доступному лише застосунку та його віджетам:

1. **Збережені адреси або черги** (до п'яти): філія, населений пункт, вулиця, номер будинку, знайдена черга (від 1.1 до 6.2), власна назва та перемикачі сповіщень.
2. **Налаштування:** час завчасного попередження, звук сповіщень, інтервал оновлення, мова.
3. **Кеш:** останній завантажений графік усіх черг, аварійні відключення й ремонтні роботи для кожної адреси, відключення в її населеному пункті та вже завантажені списки будинків, щоб застосунок і віджети працювали без зв'язку.
4. **Довідники:** перелік населених пунктів і вулиць Полтавщини та каталог «адреса → черга». Обидва вбудовані в застосунок і можуть оновлюватися з GitHub-репозиторію проєкту (розділ 4).

Файли кешу не потрапляють до резервних копій iCloud і пристрою. Розробник цих даних не отримує.

### 4. Мережеві запити

Лише через HTTPS до:

- `www.poe.pl.ua` (публічні сторінки в `/customs/`, якими користуються сторінки відключень самого обленерго): графік черг на сьогодні й завтра, діючі заходи (ГАВ, ГОП), список будинків вулиці, стан вашого будинку (черга, аварійне відключення, планові ремонти), відключення у вашій філії. Для графіка й заходів надсилається лише дата; для списку будинків — публічні коди філії, населеного пункту й вулиці; для стану будинку — публічні коди населеного пункту й вулиці **та номер будинку** кожної збереженої адреси; для відключень філії — код філії й дата. Жодних імен, ідентифікаторів пристрою чи cookies.
- `raw.githubusercontent.com` (публічний репозиторій проєкту): новіші копії переліку населених пунктів і вулиць та каталогу «адреса → черга» (не частіше ніж раз на тиждень або коли ви натискаєте кнопку оновлення у виборі адреси) і список посилань на пожертви (`donations.json`).
- `icons.duckduckgo.com` і сайти зі списку пожертв (`/favicon.ico`): маленька іконка біля посилання; запит містить лише домен сайту пожертв.

Як і під час будь-якого запиту в інтернеті, власники цих серверів бачать IP-адресу; розробник її не отримує й не зберігає. Номер будинку отримує лише сайт обленерго, якому він потрібен, щоб відповісти саме про ваш будинок; більше нікуди застосунок його не надсилає.

### 5. Дозволи та можливості iPhone

- **Сповіщення:** локальні попередження перед плановим відключенням і про аварійні відключення. Дозвіл запитується лише після вибору черги або адреси; без нього застосунок повністю працює. Push-сервера немає.
- **Фонове оновлення** (`fetch`): час від часу оновлює графік і стан ваших адрес, коли застосунок закрито. Частоту визначає iOS; його можна вимкнути в налаштуваннях iOS.
- **Віджети та App Group:** спільні адреси й графік для застосунку та віджетів. Кнопки віджета (дзвіночок, оновлення) працюють на iPhone.

Маніфест конфіденційності (`PrivacyInfo.xcprivacy`) застосунку та віджета: без відстеження, без доменів відстеження, без зібраних типів даних; єдиний API з обов'язковою причиною — `UserDefaults` (причини `CA92.1` і `1C8F.1`).

### 6. Посилання на інші сервіси

Посилання на сайт і сторінку Facebook обленерго, на сторінки пожертв (банка Monobank і фонд «Повернись живим») та на проєкт на GitHub відкриваються в Safari, поза застосунком. Застосунок не приймає платежів і нічого не дізнається про ваші дії на цих сайтах.

### 7. Діти

Застосунок для загальної аудиторії: без облікового запису, чату, вмісту користувачів і реклами. Він не збирає даних ні в кого, зокрема в дітей.

### 8. Видалення даних

- **Кнопка скидання в налаштуваннях** застосунку видаляє збережені адреси й налаштування;
- **видалення застосунку** видаляє його разом з віджетами та всіма даними App Group.

У розробника видаляти нічого, бо там нічого не зберігається.

### 9. Ваші права

Застосунок не обробляє персональних даних на серверах розробника. Права на доступ, виправлення та видалення за GDPR (ЄС) 2016/679 і Законом України «Про захист персональних даних» ви здійснюєте безпосередньо на пристрої (розділ 8). Щодо того, як сайт обленерго обробляє свої запити, діють правила АТ «Полтаваобленерго».

### 10. Зміни

Зміни публікуються в цьому файлі з новою датою оновлення; уся історія є в публічному репозиторії.

### 11. Контакт

[github.com/IgorZaharov/PoltavaBlackoutPreWarning/issues](https://github.com/IgorZaharov/PoltavaBlackoutPreWarning/issues)
