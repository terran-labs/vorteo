### Maintenance

- The health dismissal store test makes a save fail with a store directory that is a regular file. A read-only directory did not, because the atomic writer restores the directory's permissions first (#639).

## Maintenance review

Test only; functionality is unchanged. README overview and onboarding are unchanged.
