### Maintenance

- Run the installer tests on pull requests that change installer code or the installer CI job.
- Distinguish image IDs from manifest digests and report the exit code or signal when container inspection fails.

## Maintenance review

The approval-link fixture shares the standalone client's reply capability flags. It still checks owner approval, request methods and status polling independently.

If the installer job comparison fails, CI selects the installer matrix and continues the required routing check.
An attempted comparison with missing or malformed output also selects the matrix.
