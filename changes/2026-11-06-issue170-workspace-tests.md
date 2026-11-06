### Fixes

- Preserve repository project ownership through filesystem aliases, including macOS temporary directory paths.
- Align worktree placement tests with repository-owned projects while requiring unrelated projects to remain unchanged.

## Maintenance review

Reviewed synchronized projects and project organization. Repository matching now recognizes filesystem aliases without changing the repository ownership policy. README overview and onboarding are unchanged.
