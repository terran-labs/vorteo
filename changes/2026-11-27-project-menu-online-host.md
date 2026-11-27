### Fixes

- The project menu and project settings no longer pick a project's first environment when it is offline. A project such as Syn3h that the paused Dev container lists first now opens its settings and offers Turn on Factory on the Host (#682).
- When no environment can edit a project, its settings say which environment is offline, or that no online environment has the project's folder, and the project menu says why Factory is unavailable in place of leaving it out.

## Maintenance review

Issue #682. Added "Project menu host choice" to the inventory. The sidebar menu, its Factory actions and the project settings screen share one target helper; one case in the existing sidebar suite covers an offline first host. Interface only, with no daemon or wire change. New copy uses an English-only `projectHostTarget` namespace that every locale reuses, as `projectFactory` does. README overview and onboarding are unchanged. Not installed.
