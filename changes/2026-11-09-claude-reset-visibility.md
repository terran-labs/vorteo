### Fixes

- Show free Claude limit resets, such as Fable resets, in the account picker by identifying Claude usage reads as the installed Claude Code CLI.
- Label Claude resets from the limits they clear, so a weekly reset is no longer described as a 5-hour session reset.
- Show the selected account's available resets in the composer's profile button caption.

### Maintenance

- Log each change in Claude's reset eligibility per account, without grant identifiers or labels, to confirm what Claude returns.

## Maintenance review

Account reset credits now cover Claude grants that Claude previously withheld from Vorteo's usage read. Claude 1 and Claude 2 qualified, but the picker showed nothing. The leading cause is the missing Claude Code User-Agent; the new log line confirms or refutes it after installation. This requires a daemon restart. Server tests cover the User-Agent and clears-based labels. README overview and onboarding are unchanged.
