### Fixes

- On an adopted legacy Codex account that Dev paused for a changed folder, "Stop using the Host's sign-in" now withdraws the Host's sign-in and puts Dev's own back when the folder is still there, and confirming a paused stop is refused because it finishes by itself. A pause from the earlier release, which cannot say whether it was switching or stopping, offers both actions instead of "Confirm and try again" (#647).

## Maintenance review

Review condition C1 on PR #653: the owner's switch is refused on a paused undo, the owner's stop on a folder-change pause goes through the normal withdrawal and restore when the folder still pins by path, and the owner view gains optional `directionUnknown` for first-release pauses, which the app reads leniently to show switch and stop separately with existing strings. The providers guide, protocol notes and the adopted legacy Codex inventory entry are updated. README overview and onboarding are unchanged. Not published.
