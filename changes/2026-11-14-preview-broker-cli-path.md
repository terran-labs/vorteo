### Fixes

- Keep the daemon CLI path in the native preview broker's pins exactly as given. Resolving it through the release link pinned one release, so a reinstall after any Host update was refused as a changed identity.

## Maintenance review

Installer correction found while re-pinning the owner's broker: the reinstall compared a resolved release path with the pinned stable path and could never match. The CLI entry must now be a normalized absolute path to an existing file and is stored unresolved. A test repoints the release link and checks the pin still matches. README overview and onboarding are unchanged.
