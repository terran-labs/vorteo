### Changes

- Vorteo can now decide, for a Claude thread in Bypass mode, whether Claude Code's removal prompt for a command it could not analyse is safe to answer by itself: its own scan must find no delete command, and the prompt must come from the removal check alone. The answer stays off until the owner's setting arrives in a later change, so every such prompt still asks (#659).
- When the scan does find a delete, the permission request records what it found; the approval card from #667 shows it on a "Deletes:" line.
- Thread notifications can carry collapsible details, used for the record of an automatic answer.

## Maintenance review

Part B1 of issue #659. Adds a conservative shell scanner (rule version 1) that asks whenever a delete word appears as a whole token anywhere in the command, with positional rules that can only add reasons to ask, and an anchored match on the six claude.exe 2.1.321 phrasings for an unresolved removal target, answering at most once per call with no saved rule, re-reading the mode after the setting, logging only the command's digest and counting answers per turn. The setting source is absent, so the answer is always to ask; part B2 adds it. No inventory entry changes yet because no behavior is available; README overview and onboarding are unchanged.
