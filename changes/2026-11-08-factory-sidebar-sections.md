### Features

- Factories in the sidebar are rows and indented subheadings instead of cards. All Factories sits above Pinned and folds like it; each project's Factory is a folder-like row like Standing. Both rows carry a stage bar and an Overview button, and pressing a row folds it.
- The Foreman leads each project's Factory as a full-width tile labeled "Talk to the Factory", the place to start a conversation with the Factory. The other roles follow under Crew, then the runners.
- The sidebar marks which Factory overview is open: the All Factories row, or a project's Factory row together with its tile under All Factories.

### Fixes

- The board icon is gone from Factory headers; the Overview button replaces it.
- The sidebar no longer shows a Needs you count on All Factories or on Factory tiles. Questions for the owner stay in the Open questions card.

- Factory pages use the History heading style. Live mode hides sample-backed reports, and owner questions replace the overview Needs you panel while issue badges remain.
- Mobile Settings and sidebar toolbars share their surface and underline. Composer buttons no longer overlap, fullscreen keeps dictation, reset pills stay compact, folder menus align vertically and the footer clears rounded phone corners.
- Every rotating loading indicator uses the same calm 2.7-second cycle, including the boot screen.

## Maintenance review

Updated the Factory overview, sidebar, mobile layout and spinner inventory. Independent review found and verified a fullscreen dictation repair. Typecheck, root lint and 38 focused tests passed; Chromium checks covered phone composer spacing, fullscreen dictation and Settings styling. Physical iOS keyboard and safe-area behavior still needs installed-device review. Interface only; no daemon or protocol change. README overview and onboarding are unchanged.
