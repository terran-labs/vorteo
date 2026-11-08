### Fixes

- Source upgrades repeat their admission checks at approval and fail before any restart if the Host changed after approval. Snapshot restores wait for a running source upgrade.
- A source upgrade rollback stays offered when the Host moved but a later step failed, and is refused at approval or fetch once its 24-hour window ends.
- The installer replaces a source upgrade left running by a stopped coordinator instead of refusing forever. The update check skips offering a release during a source upgrade without reporting an error.

## Maintenance review

Review fixes to the unpublished source upgrade slice. The installation guide section was revised; the inventory entry still describes the feature accurately. README overview and onboarding are unchanged.
