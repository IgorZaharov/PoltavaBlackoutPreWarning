# Privacy Policy / Політика конфіденційності

**Effective Date:** November 9, 2026  
**Last Updated:** November 19, 2026  
**Application Name:** Світло в Полтаві (PoltavaBlackoutPreWarning)  
**Package Name / Application ID (Android):** `ua.blackout.prewarning.poltava`  
**Bundle Identifier (iOS):** `ua.blackout.prewarning.poltava` (widget extension `ua.blackout.prewarning.poltava.widget`)  
**Developer / Publisher:** Igor Zaharov  
**Open-Source Repository:** [https://github.com/IgorZaharov/PoltavaBlackoutPreWarning](https://github.com/IgorZaharov/PoltavaBlackoutPreWarning)  
**Contact / Issue Tracker:** [https://github.com/IgorZaharov/PoltavaBlackoutPreWarning/issues](https://github.com/IgorZaharov/PoltavaBlackoutPreWarning/issues)  

The iPhone app also has its own shorter policy, [PRIVACY_POLICY_IOS.md](PRIVACY_POLICY_IOS.md), used for the App Store listing. Both say the same.

---

## 1. Introduction and Scope

This Privacy Policy governs the mobile application **"Світло в Полтаві"** for Android (package name `ua.blackout.prewarning.poltava`) and for iPhone (bundle identifier `ua.blackout.prewarning.poltava`, iOS 17.0 or newer), hereinafter the "Application", created and maintained by Igor Zaharov ("we", "us") as a free, open-source community utility. Both versions handle data in the same way; where they differ, this policy says so (section 5 for Android, section 5A for iPhone).

The Application gives residents of the Poltava region of Ukraine timely information about scheduled power outages (графіки погодинних відключень), emergency outages and planned repair works published by **JSC "Poltavaoblenergo" (АТ «Полтаваобленерго»)** on its public website. The Application is not made by, endorsed by or affiliated with JSC "Poltavaoblenergo".

This document describes our data handling in accordance with the **Google Play Developer Program Policies**, the **Apple App Store Review Guidelines (section 5.1, Privacy)**, the **General Data Protection Regulation (GDPR) (EU) 2016/679**, and the **Law of Ukraine "On Protection of Personal Data" (Закон України «Про захист персональних даних» № 2297-VI)**.

---

## 2. What We Collect: Nothing

- **No data reaches the developer.** We have no server. We do not collect, receive, store, sell or share any personal data.
- **No user accounts:** no registration, login or profile.
- **No advertising or profiling:** no advertising frameworks or ad-tracking SDKs. The Application does not access the Android Advertising ID (AAID) or the Apple Identifier for Advertisers (IDFA) and does not track users across apps or websites, so no App Tracking Transparency prompt is shown.
- **No analytics or telemetry:** no third-party analytics or crash-reporting services (for example Google Analytics for Firebase, Firebase Crashlytics, AppsFlyer, Mixpanel or the Facebook SDK), no usage statistics.
- **No location:** the Application does not request GPS, coarse location, Wi-Fi or cell data. An address is chosen from lists.

What the Application does send, and to whom, is described in section 4: to look up the status of a saved house, it sends that address (including the house number) **directly from the device to the power company's public website**, the same input that website's own search form takes.

---

## 3. Information Kept on the User's Device

All settings and operational data stay **on the device**: on Android in the application's private storage (`SharedPreferences`, `Context.MODE_PRIVATE`); on iPhone in the application sandbox and the App Group container `group.ua.blackout.prewarning.poltava`, which only the Application and its own widgets can read.

Stored on the device:

1. **Saved addresses and queues:** up to five addresses or queues (branch (філія), settlement, street, house number, the queue found for it from 1.1 to 6.2, an optional custom name), with the per-address notification switches.
2. **Notification settings:** the pre-warning lead time, sound and vibration switches, refresh interval, language.
3. **Offline cache:** the last downloaded schedule of all queues, the emergency outages and repair works last seen for each saved address, the outages listed for the address's settlement, and house lists already looked up, so the Application and its widgets work without a connection.
4. **Reference lists:** the list of settlements and streets of the Poltava region and the address-to-queue catalogue. Both ship with the Application and can be refreshed from this project's repository (section 4).

**Backups.** On Android, if the user has turned on device backup, Android's own Auto Backup includes the settings and saved addresses in the user's Google Account backup, so they come back on a new phone; the caches are excluded (`data_extraction_rules.xml`, `backup_rules.xml`). That backup is run by Android and Google for the user; we never receive it. On iPhone, the cache files in the App Group are excluded from iCloud and device backups.

---

## 4. Network Connections and Data Sources

The Application uses the internet only for its utility function, always over HTTPS:

1. **JSC "Poltavaoblenergo" public outage pages** (`https://www.poe.pl.ua`, the public endpoints under `/customs/` that the company's own pages use):
   - **Schedule** of all 12 queues for today and tomorrow, and the **active measures** (ГАВ, ГОП): only the date is sent.
   - **Houses of a street** (when the user picks an address): the public ids of the branch, settlement and street.
   - **Status of a house** (its queue, an emergency outage, planned repair works), for each saved address: the public ids of the settlement and street **and the house number**. This is the only request that carries a house number, and it goes only to this website, which needs it to answer for that house.
   - **Outages of a branch** (the "Ремонти й пошкодження поруч" card): the branch id and the date.
   - No name, account, cookie or device identifier is sent.
2. **This project's public repository** (`https://raw.githubusercontent.com/IgorZaharov/PoltavaBlackoutPreWarning/main/…`):
   - `donations.json`: the donation links of the About screen, with conditional requests (`ETag` / `If-Modified-Since`);
   - `poe_directory.json` and `poe_queues.json`: newer copies of the settlement and street list and the address-to-queue catalogue, at most once a week or when the user taps the refresh button in the address picker.
   - Plain file requests; nothing about the user is sent.
3. **Website icons of the donation links:** `https://icons.duckduckgo.com/ip3/`, on Android also `https://www.google.com/s2/favicons`, and the `/favicon.ico` file of each donation website. The request names only the donation website's domain.

As with any internet request, the operators of these servers can see the device's IP address. We do not receive, store or combine these addresses with anything. How JSC "Poltavaoblenergo" handles requests to its website is governed by its own policies.

**Google Play Data safety and App Store label.** Because the house address leaves the device in request 1, the Google Play Data safety form declares "Personal info → Address" as collected for app functionality, processed ephemerally, optional, and not shared. The App Store label is "Data Not Collected", because Apple counts only data that the developer or its partners keep, and we keep nothing.

---

## 5. Android Device Permissions and Technical Justification

The Application requests only the permissions its core function needs:

| Permission | Technical Requirement & Justification |
| :--- | :--- |
| `android.permission.INTERNET` | To reach the public website of JSC "Poltavaoblenergo" (schedule, house status, outages) and this project's repository (section 4). |
| `android.permission.ACCESS_NETWORK_STATE` | To check whether a network is available before a request, and to tell "no internet" apart from "the power company's site is not responding". It uses only the status the operating system reports; no extra host is contacted. |
| `android.permission.POST_NOTIFICATIONS` | On Android 13 (API level 33) and higher, to show local notifications before a scheduled outage and about emergency outages. |
| `android.permission.SCHEDULE_EXACT_ALARM` | To schedule exact local alarms with Android `AlarmManager`, so a pre-warning arrives at the minute the user chose (for example exactly 15 minutes before an outage), also in Doze mode. On Android 12 and newer the user grants it in the system setting "Alarms & reminders"; the Application explains this in Settings and opens the system screen on request. Without it, warnings still arrive but may be a few minutes late. |
| `android.permission.RECEIVE_BOOT_COMPLETED` | To reschedule the pre-warning alarms after a reboot or a change of the system time or time zone. |
| `android.permission.VIBRATE` | To vibrate with a notification when the user turned vibration on. |
| `android.permission.WAKE_LOCK` | Held briefly while an exact alarm posts its notification, so it completes before the device sleeps again. |

The Application does **not** request access to contacts, camera, microphone, location, phone state, shared storage, SMS or sensors.

---

## 5A. iPhone (iOS) Capabilities and Technical Justification

| Capability | Technical Requirement & Justification |
| :--- | :--- |
| Notifications (`UserNotifications`) | Local notifications before a scheduled outage and about emergency outages. Permission is asked only after the user has chosen a queue or an address; the Application works fully without it. All notifications are created on the device; there is no push server. |
| Background App Refresh (`BGAppRefreshTask` `ua.blackout.prewarning.poltava.sync`, background mode `fetch`) | Refreshing the schedule and the status of the saved addresses from time to time while the Application is closed. iOS decides how often; the user can turn it off in iOS Settings. |
| Home-screen widgets (`WidgetKit`) and App Group `group.ua.blackout.prewarning.poltava` | Sharing the saved addresses and the cached schedule between the Application and its widgets. |

The privacy manifest (`PrivacyInfo.xcprivacy`) of the Application and of its widget declares no tracking, no tracking domains, no collected data types, and one required-reason API: `UserDefaults` (reasons `CA92.1` and `1C8F.1`). The iPhone version does **not** request access to contacts, photos, camera, microphone, location, Bluetooth, health data or the advertising identifier.

---

## 6. Third-Party Links

The Application links to:

- **JSC "Poltavaoblenergo" (АТ «Полтаваобленерго»):** [https://www.poe.pl.ua](https://www.poe.pl.ua) and its official Facebook page [https://www.facebook.com/atpoltavaoblenergo](https://www.facebook.com/atpoltavaoblenergo), for official announcements;
- **voluntary donations** (a Monobank charity jar, the "Come Back Alive" foundation `savelife.in.ua`);
- **this project on GitHub.**

They open in the browser or the banking app, outside the Application. The Application takes no payments, stores no banking details and learns nothing about what the user does on those sites. Their own privacy policies apply there.

---

## 7. Children's Privacy

The Application is a utility for general audiences. It has no account, chat, user content or advertising, and it does not target children. We collect no data from anyone, including children under 13 (or under 16 in the European Economic Area).

---

## 8. Storage, Security and Deletion

- **Storage:** user settings and caches stay in the sandbox of the operating system on the device (section 3). We operate no databases or sync servers.
- **Security:** Android and iOS sandboxing and file-system encryption protect the data; every network request uses HTTPS.
- **Deletion:** the user can delete everything at any time:
  1. the reset button in the Application's Settings (Android and iPhone) removes the saved addresses and settings;
  2. on Android, **Settings > Apps > Світло в Полтаві > Storage > Clear data**;
  3. uninstalling the Application (on iPhone, together with its widgets and App Group data). An Android backup in the user's Google Account is managed in the device's backup settings.

---

## 9. User Rights Under GDPR and Ukrainian Law

Under Chapter III of the GDPR and Article 8 of the Law of Ukraine "On Protection of Personal Data", users have rights of access, rectification, erasure and restriction of processing. Because we process no personal data on any server, these rights are exercised directly on the device (section 8). For requests to the website of JSC "Poltavaoblenergo", contact that company.

---

## 10. Changes

Changes to this policy are published in this file with a new "Last Updated" date; the full history is in the public repository.

---

## 11. Contact

- **Developer:** Igor Zaharov
- **GitHub Issues:** [https://github.com/IgorZaharov/PoltavaBlackoutPreWarning/issues](https://github.com/IgorZaharov/PoltavaBlackoutPreWarning/issues)
- **Repository:** [https://github.com/IgorZaharov/PoltavaBlackoutPreWarning](https://github.com/IgorZaharov/PoltavaBlackoutPreWarning)

---

# Політика конфіденційності (українська версія)

**Дата набрання чинності:** 9 листопада 2026 року  
**Останнє оновлення:** 19 листопада 2026 року  
**Назва додатку:** Світло в Полтаві (PoltavaBlackoutPreWarning)  
**Ідентифікатор пакета Android:** `ua.blackout.prewarning.poltava`  
**Ідентифікатор iPhone (Bundle ID):** `ua.blackout.prewarning.poltava` (віджет `ua.blackout.prewarning.poltava.widget`)  
**Розробник:** Ігор Захаров (Igor Zaharov)  
**Репозиторій проєкту:** [https://github.com/IgorZaharov/PoltavaBlackoutPreWarning](https://github.com/IgorZaharov/PoltavaBlackoutPreWarning)  

### 1. Загальні положення
Ця політика стосується мобільного додатку **«Світло в Полтаві»** для Android (`ua.blackout.prewarning.poltava`) та iPhone (`ua.blackout.prewarning.poltava`, iOS 17.0 або новіша) — безкоштовного неофіційного інструмента з відкритим кодом для жителів Полтавщини, який показує графіки погодинних відключень, аварійні відключення й планові ремонти з публічного сайту АТ «Полтаваобленерго». Додаток не створений, не схвалений і не пов'язаний з АТ «Полтаваобленерго». Політика відповідає GDPR (ЄС) 2016/679 і Закону України «Про захист персональних даних» № 2297-VI.

### 2. Розробник нічого не збирає
- Сервера розробника немає; розробник не отримує, не зберігає, не продає й не передає персональних даних.
- Немає реєстрації, входу, реклами, аналітики, звітів про збої (Firebase, Facebook SDK тощо), рекламних ідентифікаторів (AAID, IDFA) і відстеження в інших застосунках.
- Геопозиція не запитується; адресу вибирають зі списків.

Щоб дізнатися стан збереженого будинку, додаток надсилає цю адресу (разом із номером будинку) **напряму з пристрою на публічний сайт обленерго** — те саме, що ви вводите в пошук на самому сайті (розділ 4).

### 3. Дані на пристрої
На пристрої зберігаються (на Android у приватному сховищі `SharedPreferences`; на iPhone у пісочниці та контейнері App Group `group.ua.blackout.prewarning.poltava`, доступному лише додатку та його віджетам):
1. до п'яти адрес або черг: філія, населений пункт, вулиця, номер будинку, черга від 1.1 до 6.2, власна назва, перемикачі сповіщень;
2. налаштування: час завчасного попередження, звук і вібрація, інтервал оновлення, мова;
3. кеш: графік усіх черг, аварійні відключення й ремонти для кожної адреси, відключення в її населеному пункті, уже завантажені списки будинків;
4. довідники: перелік населених пунктів і вулиць Полтавщини та каталог «адреса → черга».

**Резервні копії.** На Android, якщо користувач увімкнув резервне копіювання пристрою, система Android додає налаштування й збережені адреси до резервної копії в обліковому записі Google користувача (кеш не копіюється). Цю копію робить Android для користувача; розробник її не отримує. На iPhone файли кешу в App Group не потрапляють до резервних копій iCloud і пристрою.

### 4. Мережеві запити
Лише через HTTPS до:
1. **Сайту АТ «Полтаваобленерго»** `https://www.poe.pl.ua` (публічні сторінки в `/customs/`, якими користується сам сайт):
   - графік усіх черг на сьогодні й завтра та діючі заходи (ГАВ, ГОП) — надсилається лише дата;
   - список будинків вулиці — публічні коди філії, населеного пункту й вулиці;
   - стан будинку (черга, аварійне відключення, ремонти) для кожної збереженої адреси — публічні коди населеного пункту й вулиці **та номер будинку**; це єдиний запит із номером будинку, і він іде лише на цей сайт;
   - відключення у філії (картка «Ремонти й пошкодження поруч») — код філії й дата.
2. **Публічного репозиторію проєкту** на `raw.githubusercontent.com`: `donations.json` (посилання на пожертви), `poe_directory.json` і `poe_queues.json` (новіші довідники, не частіше ніж раз на тиждень або за кнопкою оновлення у виборі адреси).
3. **Сервісів іконок сайтів** `icons.duckduckgo.com`, на Android також `www.google.com/s2/favicons`, і файлів `/favicon.ico` сайтів пожертв — запит містить лише домен сайту пожертв.

Імен, облікових даних, cookies чи ідентифікаторів пристрою не надсилається. Як і під час будь-якого запиту в інтернеті, власники серверів бачать IP-адресу; розробник її не отримує. У формі Google Play «Безпека даних» адреса вказана як «Особиста інформація → Адреса»: для роботи додатку, обробляється тимчасово, необов'язкова, не передається третім особам. Позначка App Store — «Дані не збираються».

### 5. Дозволи Android
- `android.permission.INTERNET` та `ACCESS_NETWORK_STATE`: запити до сайту обленерго й репозиторію та перевірка з'єднання.
- `android.permission.POST_NOTIFICATIONS`: локальні сповіщення перед плановим відключенням і про аварійні відключення.
- `SCHEDULE_EXACT_ALARM`: попередження у точно вибрану хвилину. На Android 12 і новіше дозвіл «Будильники й нагадування» вмикають у системних налаштуваннях; додаток підказує це й відкриває потрібний екран. Без дозволу попередження приходять, але можуть запізнюватися на кілька хвилин.
- `RECEIVE_BOOT_COMPLETED`: відновлення запланованих попереджень після перезавантаження або зміни часу.
- `VIBRATE` та `WAKE_LOCK`: вібрація й коректне доставлення сповіщення.

### 5А. Можливості iPhone
- **Сповіщення:** локальні; дозвіл запитується лише після вибору черги або адреси; push-сервера немає.
- **Фонове оновлення** (`BGAppRefreshTask` `ua.blackout.prewarning.poltava.sync`, режим `fetch`): час від часу оновлює графік і стан адрес; частоту визначає iOS.
- **Віджети** і App Group `group.ua.blackout.prewarning.poltava`: спільні адреси й графік.
- Маніфест конфіденційності: без відстеження, без зібраних типів даних; єдиний API з обов'язковою причиною — `UserDefaults` (`CA92.1`, `1C8F.1`).

### 6. Посилання
Сайт [poe.pl.ua](https://www.poe.pl.ua) і [сторінка Facebook](https://www.facebook.com/atpoltavaoblenergo) обленерго, пожертви (банка Monobank, фонд «Повернись живим»), проєкт на GitHub — відкриваються в браузері, поза додатком. Додаток не приймає платежів.

### 7. Діти
Додаток для загальної аудиторії, без облікового запису, чату й реклами; він не збирає даних ні в кого, зокрема в дітей.

### 8. Видалення даних
Кнопка скидання в налаштуваннях додатку (Android і iPhone), «Налаштування > Додатки > Світло в Полтаві > Сховище > Очистити дані» на Android або видалення додатку. Резервною копією Android в обліковому записі Google керують у налаштуваннях резервного копіювання пристрою.

### 9. Ваші права
Розробник не обробляє персональних даних на серверах, тож права на доступ, виправлення й видалення ви здійснюєте на пристрої (розділ 8). Щодо запитів до сайту АТ «Полтаваобленерго» звертайтеся до цієї компанії.

### 10. Контакти
[https://github.com/IgorZaharov/PoltavaBlackoutPreWarning/issues](https://github.com/IgorZaharov/PoltavaBlackoutPreWarning/issues)
