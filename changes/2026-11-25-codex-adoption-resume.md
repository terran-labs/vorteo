### Fixes

- An adopted legacy Codex account that Dev paused only because its folder changed now resumes by itself on an updated Dev, after Dev pins the same path again and, when needed, confirms no Dev session uses the account. One paused because the Host signed in as a different person still waits for the owner (#647).
- Saved Dev sign-in backups keep one clock per folder path, so a recreated folder is still cleaned up 30 days after the first switch, and a ninth folder is refused with a plain reason instead of losing track of an older backup (#647).
- The coordinator reads adoption records one by one and keeps fields it does not know. A record it cannot read is kept, still guards its folder, and the account shows "This account's saved switch record could not be read, so nothing is changed. Update Vorteo, or ask for help if this stays." (#647).

## Maintenance review

Coordinator side of #647: lenient record parsing, `parkedReason` and automatic resume behind `codexLegacyPinByPath`, retention keyed by real path with the ninth-folder refusal, the held person recorded at the first acknowledged projection, nothing carried after an undo that withdrew and restored nothing, and restore limited to the account's people. The providers guide, protocol notes (including the rollback step for the first adoption release) and the adopted legacy Codex inventory entry are updated. README overview and onboarding are unchanged. Not published.
