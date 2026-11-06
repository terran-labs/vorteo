### Tooling

- Desktop app builds and tests stop running on every merge while PWA releases are the only channel: Desktop Packages, the Nix desktop builds (including the macOS job) and the desktop test suites now run only when started manually.

## Maintenance review

Owner direction: desktop apps are out of scope. Routed the desktop workflows and CI jobs to manual runs and extended the CI workflow tests. No desktop tests were deleted, and required checks are unchanged. README overview and onboarding are unchanged.
