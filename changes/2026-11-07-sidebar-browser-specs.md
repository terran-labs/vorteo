### Tooling

- Sidebar browser tests follow the current sidebar: view preferences open from the main menu and are closed after a choice, pinned workspaces are addressed in their project or under Pinned, row actions count as hidden at zero opacity, plugin footer rows sit above the installation name, phone quotas open in a sheet, grouped project rows and the Environment host tiles are matched directly, and Explorer at half width hides app navigation while it is open.

## Maintenance review

Test-only repair; no shipped behavior changes. The tests now follow the footer and menu redesign (469492c4e, b866c27b7), browser-owned hover reveals (bcd8dda7a), pinned rows that stay in their group (8c1575df3), the 20-row Show more limit (8ccc81917) and the Explorer navigation rule in docs/explorer-sidebar.md. Still failing and reported instead of bent: navigation does not return after Explorer closes at 751px, keyboard focus stays on a row's actions button while its hover card is open, project groups no longer lead with the open workspace or keep active rows past Show more, and a mouse click on the queued-message indicator in a narrow window opens its tooltip and closes it again in the same click. README overview and onboarding are unchanged.
