### Fixes

- CI's dependency signature audit no longer fails on runners in one GitHub region. The desktop packaging tool electron-builder moves from 26.18.0 to the 26.18.1 patch release, which moves electron-publish off the 26.18.0 version whose attestations a network edge was answering with "OK" instead of JSON (#646).

## Maintenance review

Issue #646, item 1, second pass. Dependency-only: the electron-builder family (electron-builder, app-builder-lib, builder-util, dmg-builder, electron-builder-squirrel-windows, electron-publish) moves to 26.18.1 and builder-util-runtime to 9.7.1. No other package version changes and no package is new to the lockfile. Desktop packaging is affected and is covered by the manual Desktop Packages and Desktop Release workflows. No inventory entry changes; README overview and onboarding are unchanged.
