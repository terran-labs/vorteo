### Maintenance

- The app test run no longer hangs after every test passes. Vitest shuts down the browser tests' fixture server before it closes Chromium, and the server waited for connections Chromium still held, so the job sat silent until its 30 minute CI limit (#609). The fixture now ends held responses and closes those connections.

## Maintenance review

Test-infrastructure change only. Functionality is unchanged. README overview and onboarding are unchanged.
