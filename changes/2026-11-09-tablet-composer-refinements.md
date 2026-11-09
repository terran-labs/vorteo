### Fixes

- Keep tablet workspace tabs at the standard height while retaining the workspace name.
- Keep Send distinct from the separate Queue action on touch tablets, including drafts with images.
- Bring conversation content eight pixels closer to the composer edges and allow tablet column resizing to the available boundary.
- Give expanded context charts the same evenly segmented capacity ring as collapsed tiles, retaining category colors and adding a blue, violet and green sweep when only totals are available.
- Round Settings search and Back controls to the surrounding panel radius, match their hit-area height, and right-align the search field at its placeholder width.
- Reduce the shared phone toolbar height and balance collapsed detail tiles across rows without counting hidden cards.
- Expand phone Files, Changes and pull request details in place with the other conversation cards.
- Keep fullscreen editing in the existing editor, with actions along the bottom and profile and browser controls hidden.
- Use matching gaps between composer actions and detail tiles, center the empty phone placeholder, and keep recording at a fixed height.
- Route the phone right-edge opener to Settings and give Settings its own return-to-workspace swipe, while keeping an open sidebar's close gesture separate.

## Maintenance review

Touch attachment Send and Queue checks pass. Real SVG rendering verifies segmented charts, category colors and distinct IDs, using a temporary theme adapter. Focused checks cover card ordering, retained membership, accessory boundaries and gesture cancellation. Chromium touch checks cover slow edge swipes, Settings return, sidebar close without navigation, off-edge horizontal scrolling and maximum-width resize re-grab. Phone recording passes with coarse-pointer detection in both orientations. Fine-pointer resizing remains slow in a stylesheet-rebuilding path; comparable baseline validation is pending, so its origin is not established. The complete shared-card scenario, Settings search and Back checks, and phone inline Files and Changes expansion pass in Chromium. Phone detail tiles previously still opened sheets because they use their own tile component; they now render the sheet host's pane content in place. Independent review found that inline Changes lost its view state and that opening Files could swap Changes and the pull request; the tiles now keep panel state locally and remember the Changes or pull request choice per workspace. Phone navigation from a terminal, draft or file falls back to a sheet when no tiles are visible. Physical iPhone and iPad acceptance is not claimed. Factory pauses and installation controls are unchanged.
