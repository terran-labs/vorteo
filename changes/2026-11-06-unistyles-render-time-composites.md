### Fixes

- Compose pill, track row, subagent action and Settings sidebar styles at render time so they always pick up the saved theme instead of the startup theme.

## Maintenance review

Eleven module-level style arrays read Unistyles proxies before the persisted theme loaded, which the module-scope style rule rejects. Each array now lives in the render that uses it, with the same entries in the same order, so visuals are unchanged. The task checklist's compact ring sheet is plain React Native with no theme reads and was renamed out of the rule's pattern. The customization inventory is unchanged.
