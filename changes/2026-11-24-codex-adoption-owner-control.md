### Features

- The owner can adopt a legacy Codex account from its connection dialog, so Dev uses the Host's sign-in while keeping its history (#563, slice 2). The dialog shows the adoption's progress, a pending synchronization until Dev confirms, a failure or confirmation request with its reason, and an un-adopt control that never signs the Host out and says whether Dev's earlier sign-in was put back. The switch asks for confirmation first, because it replaces Dev's own sign-in. Once adopted, the dialog signs in on the Host, which repairs Dev too. The wording is provisional until the owner confirms it.

### Maintenance

- Owner routes `adoptions`, `adopt` and `unadopt` under `/api/installation/owner/codex/signin` list legacy Codex accounts with whether they can be adopted, and start or end one adoption at a time. Replies carry no account ID, email, token, provider ID or Dev path, and refusals answer 409 with their plain reason. Dev's daemon routes still cannot start an adoption.
- The Codex sign-in read keeps answering for a legacy account in every adoption state, so a failure or cancellation while the dialog polls no longer breaks it. Sign-in, refresh and delivery checks are unchanged.
- A Host re-sign-in as a different person, from the app or a shell, no longer reaches an adopted Dev account. Setup records a one-way digest of the verified workspace and person, every copy sent to Dev must match it, and a mismatch waits for the owner to confirm, which checks Dev's sessions and folder again.
- When the saved sign-in on Dev cannot be deleted after the 30-day cap, the account says so with the reason.
- Recovery reads that fail while Host refreshes are failing no longer count as failures, so they cannot push the next scheduled refresh further out. This applies to Claude accounts too.
- Refusal reasons the owner reads now say what to do or wait for, without internal terms.
- The browser demo adds a legacy Codex account whose adoption walks the real states.

## Maintenance review

Updates the legacy Codex adoption entry: owners can now start it, and the control's draft wording is English in every language until approved. Documents the owner routes in [providers](../docs/providers.md#adopting-a-legacy-codex-account) and their detection in [protocol compatibility](../docs/protocol-compatibility.md#claude-sign-in-upgrade). The dialog's layout on desktop and compact widths and a live adoption on an installation are unverified. README overview and onboarding are unchanged. Not published.
