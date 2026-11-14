### Fixes

- Report a busy button, or one kept focusable while disabled, as disabled to screen readers. The framework overwrote the flag, so "Check for updates" read as enabled during a check.
- Stop demo mode sending every fresh page load outside Settings to the welcome screen. The simulated installation treated the demo hosts as connections still to register.
- Name a settings row button by its visible text, then its row, without repeating itself: "Discard" on "Discard title changes" reads as "Discard title changes".

## Maintenance review

Follow-up to the settings redesign from its first full CI run, which failed 92 end-to-end specs and one server test. The specs and their shared helpers now follow the redesigned layout: host connections on the System page, controls inside collapsed Advanced groups, radio-group theme cards and the new row button names. The server test for the removed sidebar usage pin is deleted with the feature. An upstream pixel-inset test for the skills sheet is retired in the Playwright config, because the redesign adds a hint row there on purpose. A browser test covers the busy button. The end-to-end specs were not proven locally: runs on the development Mac failed on load timeouts, so a manual full CI run on the branch is the evidence. README is unchanged.
