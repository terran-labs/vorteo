### Features

- The preset fence now has a daemon setting, `presetFence`, with `report` (the default) or `enforce`, and per-path exceptions that keep logging. Only the owner's app can change it; every change, and every refused attempt, is logged with who made it and the values before and after (#360).
- An unanswered lead launch request now closes after 24 hours. Its card shows "Expired: no choice within 24 hours, so nothing was started.", and the coordinator is told to ask again (#360).

### Maintenance

- The preset fence reports why a parent chain cannot be followed (`parent-remote`, `parent-unresolved`, `cycle`, `depth-limit`), reports permission-mode changes separately as `mode-change`, tags launches by Factory role chains as `factory-role-unverified`, and covers `paseo agent switch-profile` when the CLI names its calling agent (#360).
- Agent tool calls can no longer set `paseo.lead-launch-id`, `paseo.lead-requested-by` or `vorteo.factory-role`; only daemon code sets them (#360).

## Maintenance review

Updated the "Owner-confirmed lead launches and the preset fence" inventory entry: the `presetFence` setting and who may change it, the reasons that stay report-only, lead launch expiry, reserved labels and the caller-identity limits (#525). Protocol: optional `presetFence` in the mutable daemon config and its patch, and optional `callerAgentId` on `agent.profile.switch.request`; the daemon advertises `presetFenceSetting`. README overview and onboarding are unchanged. Source only; not installed.
