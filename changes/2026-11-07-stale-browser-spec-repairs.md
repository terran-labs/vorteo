### Tooling

- Repair stale browser tests: question cards advance with Next after single-select picks, the add-host chooser stays open after Cancel, the model picker opens drilled into the selected provider, folder rows show home-relative paths, phone workspaces wait for the compact tab switcher, desktop workspaces are named by their sidebar row instead of a title header, and Files card names no longer collide with assistant file links. Demo tests check the task row rather than the open question that names it.
- Profile editor feature fields carry stable test IDs again, so the Codex speed test can find the Speed control.
- Route out the upstream compact sidebar close-button test: Vorteo has no close button or built-in nav rows in that sidebar.
- The Explorer resize test finds the docked handle, which is itself the separator, and the demo test closes the focused row's workspace card before the project flyout. Both now reach assertions that still fail on product behavior.

## Maintenance review

Test routing and test IDs only; no shipped behavior changes. The question card follows 70cb34927, the add-host flow follows 7c2812dde, the Explorer handle follows 60f4899a6, folder rows follow 40b33e0ad, the compact tab switcher follows 01f9bc829, and the retired close-button test cites 471d7f22a. Still failing on product behavior and reported to Builds: Explorer drags rerender split panes, the demo logs native accessibility props on web elements, and the phone workspace tests that expect the documented header and a retained Explorer after a file sheet. README overview and onboarding are unchanged.
