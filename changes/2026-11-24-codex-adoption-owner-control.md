### Features

- The owner can adopt a legacy Codex account from its connection dialog, so Dev uses the Host's sign-in while keeping its history (#563, slice 2). The dialog shows the adoption's progress, a pending synchronization until Dev confirms, a failure or confirmation request with its reason, and an un-adopt control that never signs the Host out and says whether Dev's earlier sign-in was put back. Once adopted, the dialog signs in on the Host, which repairs Dev too. The wording is a draft awaiting approval.

### Maintenance

- Owner routes `adoptions`, `adopt` and `unadopt` under `/api/installation/owner/codex/signin` list legacy Codex accounts with whether they can be adopted, and start or end one adoption at a time. Replies carry no account ID, email, token, provider ID or Dev path, and refusals answer 409 with their plain reason. Dev's daemon routes still cannot start an adoption.
- The Codex sign-in read keeps answering for a legacy account in every adoption state, so a failure or cancellation while the dialog polls no longer breaks it. Sign-in, refresh and delivery checks are unchanged.
- The browser demo adds a legacy Codex account whose adoption walks the real states.

## Maintenance review

Updates the legacy Codex adoption entry: owners can now start it, and the control's draft wording is English in every language until approved. Documents the owner routes in [providers](../docs/providers.md#adopting-a-legacy-codex-account) and their detection in [protocol compatibility](../docs/protocol-compatibility.md#claude-sign-in-upgrade). The dialog's layout on desktop and compact widths and a live adoption on an installation are unverified. README overview and onboarding are unchanged. Not published.
