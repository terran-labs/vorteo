### Tooling

- Browser tests that open Settings follow the reorganized sections: Appearance is a pane in Interface, the language menu is chosen from Interface > Language instead of the ambiguous System button, Help lives in System > About, and the Vorteo update check sits behind System > Updates > Details. A shared `chooseSettingsLanguage` helper replaces both copies of the old language step.

## Maintenance review

Test-only change; no shipped behavior changes. The repairs follow the Settings reorganization in 2eda5255a and the System consolidation in 90ea0adb4. The phone toolbar check skips the svg glyph assertion for the menu toggle, which draws its lines without an svg. README overview and onboarding are unchanged.
