### Fixes

- A workspace no one is viewing shows its new branch right after a checkout or branch switch, in the sidebar and the command center, instead of keeping the old branch for up to 30 minutes. Refs #675.

## Maintenance review

Regression from the idle repository fetch change (#686). Repository metadata events for an idle workspace were all deferred to its next activation or idle release, including the workspace's own HEAD moving, so its branch stayed stale. A HEAD event now marks the routed refresh, and an idle workspace runs that refresh at once. Fetch fan-out, packed-refs, remote ref and index events stay deferred, so the idle fetch and rescan savings remain. Measured with a real repository and the file observer: an idle workspace saw a branch switch after about 1.8 s before #686; after it, not within 8 s either alone or beside an active sibling; with this change, about 1.2 s in both. Degraded polling keeps its existing five minute idle interval, unchanged since before #686. The existing idle worktree case now also asserts that a HEAD event refreshes the idle worktree within a second; it fails without the fix. Updated the workspace Git fetch entry in the inventory. README overview and onboarding are unchanged.
