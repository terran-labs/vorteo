### Fixes

- Preserve repository project ownership through filesystem aliases, including macOS temporary directory paths.
- Normalize the expected registry path to native Windows separators while retaining exact path assertions.
- Align worktree placement tests with repository-owned projects while requiring unrelated projects to remain unchanged.

## Maintenance review

Reviewed synchronized projects and project organization. Repository matching now recognizes filesystem aliases without changing the repository ownership policy. README overview and onboarding are unchanged.
