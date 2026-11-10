### Fixes

- A participant scope restore that fails while staging its bytes now removes the partial staging file.

## Maintenance review

Applied the broker scope restore review notes: staging writes run inside the cleanup guard, and one test now covers an unreadable outcome under both the new and the previous configuration and fails if a restore stages in the job's work folder. README overview and onboarding are unchanged.
