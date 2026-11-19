# First-run tour

Owner request, 2026-11-17. Android (`ui/components/OnboardingTour.kt`, `CoachMarks.kt`) and the web simulator (`src/services/onboarding.ts`, `src/components/CoachTour.tsx`) follow this file. The step cases are in `OnboardingTourTest.kt` and `tests/onboarding.test.ts`. iOS gets the tour together with the POE address picker (milestone I2). Until then it only has the first-launch tip (step 0).

## Steps

| Step | Where | Lit (the rest is dimmed) | Tip and arrow |
|---|---|---|---|
| 0 | Main screen, no address or queue yet | the «Виберіть чергу» button (the first-launch overlay) | «Спробуйте вибрати будь-яку адресу або чергу», arrow down at the button |
| PICK | Address lookup dialog, no result card | settlement field, its hint, street and house fields (one block) | «Тепер виберіть населений пункт, вулицю та будинок» outside the block; the next field to fill (house, else street, else settlement) is ringed in the accent colour |
| APPLY | Address lookup dialog with a result card (a house, or a place without streets or houses) | the result card | «Натисніть, щоб обрати чергу» outside the card (next to the button when the card fills more than 55 % of the screen); the «Обрати чергу» / «Додати чергу» button is ringed and scrolled into view |
| RENAME | Settings with an address | the first address card's rename button | «Перейменуйте адресу для зручності: «Дім», «Робота»» with «Далі» |
| ALERTS | Settings, after «Далі» or after the rename dialog closes | the card's «Планові» and «Аварійні» switches; the dock's home button | «Оберіть, про які відключення сповіщати для цієї адреси: планові чи аварійні»; «Поверніться на головний екран» at the home button |
| ABOUT | Main screen after RENAME was shown | the dock's About button | «Або допоможіть волонтерам, якщо хочете задонатити» with «Зрозуміло» |

Steps PICK to ABOUT come from `tourStep(active, lookupOpen, resultShown, page, hasAddress, reachedRename, renameDone, covered)`:
1. Not active, or another dialog is on top (a picker list, rename, remove): nothing is shown.
2. Lookup open: APPLY with a result card, PICK without one.
3. No address saved: nothing is shown.
4. Settings: ALERTS after the rename step is done, RENAME before.
5. Main screen after RENAME was shown: ABOUT.

## Rules

- **Start and end.** The tour starts when the first-launch «Виберіть чергу» button is tapped, unless it was finished before. It ends with «Зрозуміло», with «Пропустити підказки» (in the first tip of every step), or when About is opened after RENAME. It is then never shown again. Android keeps the flag in the `onboarding` preferences; the web keeps it in `localStorage` `onboarding_done`, cleared by the simulator's reset.
- **Dim layer.** The dim layer is `#05080F` at 78 %. Holes are 6 dp larger than the lit controls, with a 14 dp radius. Touches on the lit controls (inside the holes) and on the tips go through, so the user works with the lit controls directly.
- **A tap outside goes on** (owner, 2026-11-17; `outsideTap(step)` / `tourOutsideTap`). From RENAME on, a tap anywhere else is taken (nothing underneath reacts, not even a scroll) and goes to the next tip: RENAME → ALERTS, ALERTS → the app switches to the main screen (ABOUT), ABOUT → the tour ends. In PICK and APPLY the next tip needs the address, so such a tap does nothing there.
- **Scrolling.** The control a tip points at is scrolled into view (PICK and APPLY in the lookup dialog, RENAME and ALERTS in Settings).
- **Tip placement.** A tip goes above its anchor when the anchor's centre is in the lower 55 % of the screen, otherwise below it. The arrow (accent, 32 dp) sits between tip and anchor and nudges 8 dp towards the anchor; it stands still when system animations are off or under reduced motion.
- **Dialogs.** A dialog is its own window on Android, so the lookup dialog draws PICK and APPLY in its own overlay, and the main window draws RENAME, ALERTS and ABOUT.
