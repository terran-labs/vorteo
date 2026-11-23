### Features

- The preset fence now has an owner setting, `presetFence`, with `report` (the default) or `enforce`, and per-path exceptions that keep logging. Only the owner's app can save it. It is kept in its own file, `preset-fence.json`, not `config.json`, and is read once at the next daemon restart. This release never enforces: a stored `enforce` is kept but logged at warn and treated as report until a later release enables it. The daemon logs the policy in force and where it came from at startup, and warns when a stored policy is unusable, names an unknown path, or is not a small regular file (#360).
- An unanswered lead launch request now closes after 24 hours. Its card shows "Expired: no choice within 24 hours, so nothing was started.", and the coordinator is told to ask again (#360).

### Maintenance

- The preset fence reports why a parent chain cannot be followed (`parent-remote`, `parent-unresolved`, `cycle`, `depth-limit`), reports permission-mode changes separately as `mode-change`, tags Factory role chains `factory-role-unverified` without exempting them, and covers `paseo agent switch-profile` when the CLI names its calling agent (#360).
- `paseo.lead-launch-id`, `paseo.lead-requested-by` and `vorteo.factory-role` can no longer be set by agent tool calls or by session requests from non-app clients; only daemon code sets them (#360).

## Maintenance review

Updated the "Owner-confirmed lead launches and the preset fence" inventory entry: the restart-only `presetFence` setting in `preset-fence.json` and who may save it, the reasons that stay report-only, no exemption for an unverified Factory role label, lead launch expiry, reserved labels and the caller-identity limits (#525). Protocol: write-only `presetFence` in the daemon config patch, optional `callerAgentId` on `agent.profile.switch.request`, and the `presetFenceSetting` capability. Older daemons ignore `preset-fence.json`, so rollback needs no preparation. README overview and onboarding are unchanged. Source only; not installed.
