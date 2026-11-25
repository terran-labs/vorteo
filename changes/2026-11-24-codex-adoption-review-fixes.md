### Maintenance

- Review fixes for legacy Codex adoption before release (#563):
  - A Dev sign-in is replaced only when it names the same person as the Host's, not just the same ChatGPT workspace. Codex's account ID is the workspace, which every member of a Team workspace shares. Host verification refuses a sign-in that names no person. This also applies to managed Codex homes.
  - The coordinator reads the Host's credential file before it starts Codex for a refresh. With six minutes or less left on the access token, when Codex could refresh on its own as soon as it is asked anything, it starts Codex only under the Host lease, or not at all.

## Maintenance review

Updates the legacy Codex adoption inventory entry and [providers](../docs/providers.md#host-owned-codex-sign-in-for-installations). README overview and onboarding are unchanged. Not published.
