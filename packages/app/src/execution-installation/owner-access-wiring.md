# Owner controls integration

These new files are scaffolding, not connected Settings behavior. No existing file was edited.

## Panel source

Add this export inside `panel.tsx` after `useInstallationOwnerClient` (and import the `OwnerAccess` type from `owner-access.ts`). The existing app-wide session host owns initialization. Returning the model's state preserves its session restoration and failure handling.

```tsx
export function useInstallationOwnerAccess(): OwnerAccess {
  const model = getInstallationPanel(useHostRegistryLoaded());
  const state = useSyncExternalStore(
    model?.subscribe ?? noSubscription,
    model?.getState ?? (() => null),
    model?.getState ?? (() => null),
  );
  let status: OwnerAccess["status"] = readExecutionInstallation() ? "checking" : "none";
  if (state?.initialized) status = state.unlocked ? "unlocked" : "locked";
  return {
    status,
    busy: state?.busy ?? false,
    error: state?.error ?? null,
    unlock: async (password) => {
      if (!model) throw new Error("Owner controls are still loading.");
      model.setPassword(password);
      try {
        await model.unlock();
      } finally {
        model.clearPasswordDraft();
      }
    },
    lock: async () => {
      if (!model) throw new Error("Owner controls are still loading.");
      await model.lock();
    },
  };
}
```

Then import `useInstallationOwnerAccess` in `owner-access.ts` and change the context's default source from `useImportableOwnerAccess` to `useInstallationOwnerAccess`. Remove the obsolete fallback and its imports. Until then, the fallback observes unlocked state but cannot distinguish restoration from locked or perform actions; actions explicitly fail with a reserved-line error.

## Query boundaries and placement

- Split `settings-status.tsx`: the exported `InstallationSettingsStatus` must render `OwnerLockedGroup` outside an inner component containing **all** existing hooks, including `useInstallationSettings`. Wrapping the existing return's children is insufficient. Gate Providers, Plugins, Agent tools, Metadata, Workspaces and Terminal profiles this way. Pass each pane's title to the outer group.
- The group render callback receives `{ disabled }`. In peek mode render a static, disabled preview or explicitly disable every owner query in the subtree. Do not mount the existing fetching status component in peek mode. The visual wrapper alone cannot prevent effects or keyboard actions within an arbitrary subtree. Apply disabled to controls as well as queries.
- Wrap `installation-name-section.tsx` at its outer boundary; its descriptor-based name read is safe, but saving requires the owner session. A peek can display the current name as text.
- Put `OwnerLockBadge` in the held Settings sidebar footer and/or the `settings-scroll-page` header. It uses a constant 224 by 44 control footprint plus a permanently reserved 24-pixel action-error slot.
- Replace the held panel's `InstallationOwnerAccess` inline form with `OwnerUnlockDialog`. Preserve `PasswordFileHint` and its server-reported path outside the dialog, or extend the source with that optional hint. Do not invent a password path. The dialog currently explains that the host installer generated the password.
- `execution-installation/project-exclusions.tsx` handles `OwnerAccessExpired`; gate its owner-only actions at their outer boundary. `provider-usage/claude-setup-login.ts` and `provider-usage/codex-installation-login.ts` use owner provider-secret operations; gate their initiating controls too. Profile CRUD and provider credentials use `profiles.ts` and `provider-secrets.ts`, so any profile editor or account control outside the six shared panes also needs this gate.

The shared settings, profiles, provider-secret, plugin and skill clients use owner endpoints and reject 401 responses. Installation name also rejects 401, with its own error message. This is a UI affordance; server authorization remains authoritative.
