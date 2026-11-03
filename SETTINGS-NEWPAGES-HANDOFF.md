# Settings profile page and System view

New components only. No held files changed. The standalone editor delegates to the held modal; the new form therefore composes its exported model, catalog and feature hooks, appearance control, and worker choice functions instead of copying modal implementation.

## Deferred wiring

- Profile entry points: replace modal opening with `/settings/profiles/[profileId]`, supplying providerType and serverId. Register `settings/profiles/[profileId]` beside `settings/[section]` in app/\_layout.tsx if explicit Stack registration is required. No settings/\_layout.tsx exists on this base. Composer should mount AgentProfileCenteredModal with save/delete callbacks using the current profile snapshot and saveProfiles.
- host-page.tsx: replace HostStatusBadges (179-230), RestartDaemonCard (613-720), UpdateDaemonCard (728-915) with SystemView rows. Route each row action to existing approval, reconnect or update handlers. Supply the existing Restart controls through restartMenu, preserving confirmation and finish-current-turns behavior. Move detailed versions, release source, connection diagnostics and progress receipts into the corresponding Details slot.
- desktop/components/desktop-updates-section.tsx: merge LocalDaemonSection (328-500) status and actions into Host; retain diagnostics under Host Details.
- settings-screen.tsx: remove duplicate HostVersionRow (577-629) and InstallationConnectionCheck (557) once their information appears under Host Details.
- execution-installation/panel.tsx: merge InstallationRestartBanner (2177-2380), RestartActions (1844-1945), and InstallationUpgradeCard (568) primary actions into SystemView. Keep job history, impact, failure evidence and advanced restart choices under Details.
- vorton-updates/section.tsx: merge InstallationUpgradeSection into the System update action; move release and upgrade-step detail under Details.
- Adapter ownership: read useHostRuntimeSnapshot per target; pass enrollment, owner jobs/upgrades/service queue when unlocked and public restart summary when locked. Preserve last known snapshots during polls. Global public counts deliberately affect both environment rows because they carry no target attribution. Derive the optional services row through deriveSystemServices.

## Validation and limits

Targeted Vitest: 18 tests passed across profile page model and System status model. Required application TypeScript check fails with widespread missing workspace protocol/client package declarations; no clean typecheck or browser verification claimed. Logs: /tmp/settings-newpages-tsc.log and /tmp/settings-newpages-tsc-final.log.

New profile form keeps feature controls in a fixed-height scroll region to prevent catalog refreshes shifting later sections. Save bar overlays content. Errors use toast; navigation and browser unload protect dirty drafts. The route retains the initial profile snapshot for conflict checks.

Remaining integration risks: verify shared installation profile persistence and provider ancestry in the integration adapter; direct route currently uses local useAgentProfiles write path. Skills choices use provider identity supplied to the form, so derived account IDs need ancestry resolution at integration. Maximum workers currently edits positive finite limits while preserving an existing uncapped value. Browser and native visual acceptance are outstanding. Existing daemon-reconnect files were left untouched.

Changed-file formatting and lint pass. Local lint exceptions allow draft-bound inline props on these small form surfaces. The first commit attempt failed the required changelog hook (existing file edits are prohibited) and workspace typecheck (duplicate ambient declarations, missing server exports and unrelated package errors); retry excludes vorton-version and typecheck under the common brief. Fresh declarations hook passed.
