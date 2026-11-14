### Fixes

- Refuse a published path that is itself a link, verify each directory step of a snapshot copy by device and inode, and stop a copy that exceeds its entry, depth or 60 second budget.

## Maintenance review

Final review items on the unreleased Previews snapshot copy worker: the named root is checked without following links and re-verified after entering it, a single file is opened by bare name from its verified directory, every visited entry and the tree depth are budgeted, short writes are completed, and the daemon stops a worker at a deadline and waits for it to close before removing the partial snapshot. README overview and onboarding are unchanged.
