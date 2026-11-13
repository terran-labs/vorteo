### Fixes

- Tie feedback on a live preview to the exact version the owner reviewed. The comment frame, the confirmation page and the daemon carry that version, and a send is refused when the address has been published again since.
- Copy snapshots in a separate process that walks the published tree by working directory and opens files by bare name without following links, so a tree rewritten during the copy cannot redirect it.
- Read the Previews version row style inside the stylesheet, not at module load, and add the Previews icon to one test's local icon mock.

## Maintenance review

Second security review round on the unreleased Previews gallery, plus two app unit test failures found by running the app suite locally (a module-scope style read flagged by the Unistyles scope test, and a missing icon in a test-local mock). The thumbnail worker comment now states that server redirects are not rechecked and why that is safe. The guide describes the copy process and the version binding. README overview and onboarding are unchanged.
