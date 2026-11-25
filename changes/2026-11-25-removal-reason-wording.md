### Fixes

- A permission card for a removal Claude Code knows is dangerous no longer says it "could not rule out" deleting files. A critical path, the working directory or an ancestor, a possibly-empty variable path, a drive root, a mounted drive or an unplaceable Windows path now reads "Claude Code's safety check stopped this command because it would remove a dangerous target." followed by Claude Code's own reason and path. The "could not rule out" sentence stays for removals whose target the check could not tell (#659).

## Maintenance review

Follow-up to #663 for issue #659. The display match now separates the unresolved-target families (statically-unresolvable target, the four "not ruled out" forms and the unreadable shell -c script, for rm and rmdir) from the known-target families, taken from claude.exe 2.1.321. One table case per family. Display only; it decides nothing. No inventory entry changes; README overview and onboarding are unchanged.
