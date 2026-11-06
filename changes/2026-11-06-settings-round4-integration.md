### Maintenance

- Merge current `main` (26.11.504 and the change-fragment rules) and the Settings round 4 review fixes into the Settings round 4 integration branch. Changelog and inventory entries from both sides are kept unchanged, with Settings' older unreleased entries above the current ones.
- A wrong owner password now keeps its error in the unlock dialog's reserved status line, and the panel stays locked. Before, clearing the password draft also cleared the error, so a failed unlock showed nothing.
- The metadata picker browser check compares the picker's height with its content and borders, capped at 400 pixels, while still checking that it stays inside the viewport.

## Maintenance review

Settings round 4 integration: owner unlock failures now report their error, and the metadata picker check is tightened. The rest of round 4's inventory entries are already recorded. README overview and onboarding are unchanged.
