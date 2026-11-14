### Maintenance

- Add the Previews card's icons to the app's browser-test icon stub, so browser-mode tests that load the task cards import cleanly.

## Maintenance review

Test-only correction to the unreleased Previews gallery. The question form card browser test failed to import because the icon stub lacked `Images`, `Columns2` and `Presentation`. Production code is unchanged. README overview and onboarding are unchanged.
