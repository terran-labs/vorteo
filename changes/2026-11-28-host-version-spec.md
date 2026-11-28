### Maintenance

- The Host version browser spec opens Diagnostics in Host details before reading the version, since #665 folded transport, version, process and commits into Diagnostics until asked for (#656).

## Maintenance review

Test only; functionality is unchanged. The spec still checks that the owner can read the Host's version in System details before the daemon stops, while it is stopped, and after it restarts on a new version, without a page reload. No other browser spec reads the lines Diagnostics now folds. README overview and onboarding are unchanged.
