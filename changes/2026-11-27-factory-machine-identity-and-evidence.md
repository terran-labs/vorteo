### Improvements

- Factory owners can generate a project signing key, inspect its public identity and rotate it after enrolling the replacement.
- Factory can exchange signed heavy test results through GitHub without changing a pull request's head.

## Maintenance review

The receipt verifier checks the enrolled signing key, the pinned command list and the current challenge. A secondary can retry a failed receipt upload without executing the same batch again. Key rotation and receipt verification have been tested using private temporary homes.
