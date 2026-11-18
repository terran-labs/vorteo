### Fixes

- Clearing or marking attention on a closed thread can no longer overwrite a resume that is loading the same thread, or leave the loaded thread showing the old attention state.

## Maintenance review

Review follow-up to clearing attention without loading. The stored-record path of clearing attention and of marking a thread unread now runs in the agent's lifecycle lane, the same lane resume uses, and re-checks whether the agent loaded meanwhile before taking the stored path. Clearing skips archived records. The existing attention test adds a clear that arrives during a resume. No feature entry change. Not installed. README overview and onboarding are unchanged.
