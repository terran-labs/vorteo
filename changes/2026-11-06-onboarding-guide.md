### Features

- Add a skippable Vorteo setup guide after owner sign-in. Progress belongs to the installation in this browser, Skip stays distinct from Finish, and **More > Show setup again** reopens it. The branded welcome and demo remain; the upstream walkthrough stays hidden.
- Add Follow system alongside the Vorteo appearance presets. Setup also shows saved agent tools and skills, changing them only through explicit actions.
- Setup offers one detected Host provider and highlights a verified sign-in. Existing installation controls own sign-in and supported sharing to Dev; additional providers stay in Settings. An explicit Use saves the primary connection on supported hosts. Older hosts keep the choice only in the guide and say it was not saved. Skip and account creation never choose a primary connection.
- Show the Projects folder, retain manual Add project and offer capability-gated suggestions from agent history with retry. The System project does not count as a first user project.
- Explain PWA access and supported direct or SSH Add host methods, with an installation-address QR code and CLI help. Phone pairing and app-store links stay retired.

### Maintenance

- Resolve the chosen account from the same Settings snapshot whose revision guards the primary write. The shared helper retries one concurrent edit; removed, disabled or unavailable choices and failed saves keep an error and Retry without advancing setup.
- New guide text uses an English fallback in the other eight locales pending translation. Provider snapshots do not expose structured installed-but-signed-out state, so setup directs unverified providers to Settings rather than guessing.

## Maintenance review

The guide adapts upstream setup navigation and project-history discovery to owner-authenticated Vorteo installation setup, preserving profiles, explicit shared-setting authority and supported device access. The feature inventory and README onboarding text are updated. Focused validation is recorded in the task handoff; browser, device and installed acceptance remain separate.
