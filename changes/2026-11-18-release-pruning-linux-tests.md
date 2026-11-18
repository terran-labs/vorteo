### Maintenance

- Make the Host release reference-file test hold on Linux: the Chrome wrapper and the LaunchAgent text search run on every platform, real property list parsing is checked with plutil on macOS and as a refusal elsewhere.

## Maintenance review

CI on Linux failed the LaunchAgents test because property list parsing is refused off macOS, the documented fail-closed behaviour. The test now asserts that refusal on Linux instead of assuming plutil. The two mode-000 tests skip when run as root, which reads any file regardless of mode. Tests only. Not installed.
