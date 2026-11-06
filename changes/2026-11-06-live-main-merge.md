### Tooling

- Merged current `main` into `live/main` for delivery, so the live edits reach `main` through the usual pull request.
- Merged the latest `live/main` again, including the upgrade time estimate, which now joins main's release notes and install decisions in the upgrade approval text and card.
- Merged `live/main` once more for the command center and status list hover surfaces.
- Merged `live/main` for the Live dev `+N` version suffix and the always-visible breadcrumb plus. The version suffix file now references Expo's `require.context` types itself, so clean checkouts and CI type-check it without the dev server's generated `expo-env.d.ts`.
- Merged `live/main` for the quieter sidebar busy ring and rows that no longer brighten on hover, keeping main's pin marker.

## Maintenance review

Merged current `main` into `live/main` for delivery, keeping both sides. The sidebar keeps live's CSS hover and calm rows and gains main's Pinned folder row and pin marker. The installation upgrade card keeps live's step layout and gains main's release notes and install decisions. Custom domain settings stay in Installation controls. The merge also adds the trailing icon slot constant, removes stale hover props from the status list and switches raw scrollers to the shared fading scrollers, all of which `live/main` needed in order to typecheck and lint. README overview and onboarding are unchanged.
