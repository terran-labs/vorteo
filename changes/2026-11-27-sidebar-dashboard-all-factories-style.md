### Fixes

- The sidebar's Dashboard row and All Factories block now use the same calm text and icon colors as the Pinned and project rows, and line up with them, including inside a project (#672).
- The All Factories block highlights as one surface on hover, and opens the Factories page from anywhere on it. Its color bar and "Queue snapshot" line are gone; the title and two count lines remain (#672).

## Maintenance review

Interface only. The Dashboard row and the All Factories block now reuse the folder row's geometry, leading slot, calm title, and hover, pressed and selected fills; a Dashboard glyph joins the existing calm sidebar glyphs. Updated the "All Factories section" and "Installation dashboard" inventory entries. No test added: the change is styling, which the testing budget excludes. README overview and onboarding are unchanged.
