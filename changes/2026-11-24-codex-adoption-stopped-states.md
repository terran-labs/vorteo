### Maintenance

- Legacy Codex adoption follow-ups before release (#563):
  - Dev's saved sign-in is deleted on schedule in every adoption state, also after a cancel, a failure or a changed Dev folder. Before, retention ran only while an account stayed adopted, so a stopped adoption kept the copy forever.
  - Un-adopting a cancelled, failed or confirmation-pending adoption records that Dev's earlier sign-in was not put back, so the app can say so.
  - Re-sending the Host's copy to Dev, which repairs a Dev refresh that overwrote it, keeps running while Host refreshes fail, without spending refresh retries.

## Maintenance review

Updates [providers](../docs/providers.md#adopting-a-legacy-codex-account). The recovery change is in the shared Host refresher, so Claude recovery also re-reads and re-sends during refresh failures; it still refreshes only under the retry budget. The inventory entry is unchanged. README overview and onboarding are unchanged. Not published.
