### Maintenance

- Prepared an inactive `factory-review` commit status for the Factory's independent review (#311, part of #252). It decides success only for an approval of a pull request's exact head from that issue's reviewer, posts idempotently and refuses without writing when the App credential is missing or malformed. Nothing calls it yet, no GitHub App exists and no status is posted.

## Maintenance review

Issue #311. Added `factory/project/review-status.ts` with the status decision, a reply parser that applies the queue's recorded-review line rules, a posting function with a shape-only credential check, a live client that refuses every call and a dry-run client that records intended writes. A new focused test file covers exact-head approval, stale-head rejection, findings, non-independent and foreign verdicts, idempotency, missing and malformed synthetic credentials and the disabled live client; it is a new file because the module is new and the Factory service suite is being changed by concurrent work. The Factory guide gains an Enforced review section with the current verdict path, the custody limit and the owner and Builds steps for #252; the inventory gains a preparation entry. No charter, instructions, ruleset, credential or installation change. README overview and onboarding are unchanged. Not installed; nothing in it runs.
