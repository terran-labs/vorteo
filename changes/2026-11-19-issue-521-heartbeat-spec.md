### Fixes

- The machine turn line now reports whether it is open to screen readers on web, and the browser test for scheduled heartbeat turns opens the line before looking for the heartbeat row.

## Maintenance review

Issue #521 follow-up. The Machine turn lines entry gains the web expanded state; behaviour is otherwise unchanged. The scheduled-heartbeat browser test, which pull request checks do not run, still looked for the heartbeat row directly; in the Collapse turns display that row sits behind one closed machine line. The test now finds the line by test id and role, checks it is closed, opens it and sees the row, with every later check unchanged. Running it showed the line had no `aria-expanded` on web, because React Native Web does not map the accessibility state; the line now sets it. README overview and onboarding are unchanged. Not installed.
