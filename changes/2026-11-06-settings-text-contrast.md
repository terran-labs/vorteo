### Fixes

- Settings > System is legible in dark mode again. The Host and Dev rows, their status, their Details links and System services had no text color, so they fell back to black on the dark background. They now use the Settings theme styles in a card like the other sections, and statuses show as colored badges. The Restart menu's More button no longer truncates.
- The remaining Settings text without a color now uses the Settings theme styles: the profile page title and its loading and error lines, profile form headings and scope notes, profile skill names, the locked installation name preview, and maintenance and repair setup errors.

### Maintenance

- A browser test fails if any System label falls back to the default black or an inherited color, so this can't quietly return. Theme contrast for every theme stays covered by the theme tests.

## Maintenance review

Settings text colors now come from theme tokens throughout System and the affected rows; no behavior change. README overview and onboarding are unchanged.
