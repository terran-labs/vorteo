### Fixes

- Give card and sidebar section headers, including Open questions and Quota, the same quiet hover fill and 8px corners as the workspace rows.
- Match small sidebar row actions (the project add button and the workspace menu trigger) to the row's kebab hover.
- Align the conversation resize bar with the message field's right edge.

## Maintenance review

Hover styling now converges on the workspace row treatment for sidebar rows and card headers. Menus, popovers, primary, secondary and destructive buttons, selected states and pill tabs intentionally keep their own treatments, because the sidebar hover tone does not contrast on their surfaces. The column resize handle and the composer share one inset constant. Browser checks confirm the handle center matches the message field edge and the card header hover token and radius. README overview and onboarding are unchanged.
