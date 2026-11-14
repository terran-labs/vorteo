### Maintenance

- Vendor Vorton's generated theme reference from commit e8e7980 with its source commit and SHA-256, and add a sync script that copies it from a local Vorton checkout.
- The theme test now fails when a Vorteo palette color drifts from the Vorton reference, when a declared exception no longer differs, or when the vendored file is edited by hand. Neon and Scriptorium accents are declared owner-approved exceptions; 30 other differences (raised surfaces, accent text on Midas, Ember and Neon, and the shared status and destructive colors) are listed as undecided pending the owner.

## Maintenance review

Tooling and tests only; no color changed. Updated the six-theme inventory entry to name Vorton as the palette reference and describe the drift check. The sync script's test runs in the CI contracts step. README overview and onboarding are unchanged. Not merged or installed.
