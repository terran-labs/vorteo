### Fixes

- Settings pages that locked when owner access expired now unlock again within a few seconds after you unlock on another page or tab. The page asks the server to confirm the session; it never trusts another page's word for it.
- A shared plugin you were adding or updating stays open, with its reviewed source, while Settings is temporarily locked, so you can save it after unlocking.

## Maintenance review

Protected owner access now re-checks the server session on each panel refresh while locked, and the shared plugin form lives outside the owner gate until saved or closed. Server authorization of every protected request is unchanged. Updated the protected owner access inventory entry. README overview and onboarding are unchanged. Validation: focused panel, owner access, owner lock and shared plugin form tests passed; app typecheck reports only the packaged e2e spec's missing server build; lint passed. The packaged Linux recovery cases from #217 still need a run.
