### Maintenance

- The lean Factory merged a private scratch pull request after a hosted check, independent review and separate Lead acceptance on the same commit. The Builder needed one-time permissions to commit, push and open the pull request.

## Maintenance review

Restart recovery now closes settled issue runners and preserves their workspaces. A focused integration test verifies that review can run while hosted checks are pending and that acceptance still waits for passing checks.
