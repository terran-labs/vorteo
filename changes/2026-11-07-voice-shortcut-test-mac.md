### Tests

- The fullscreen dictation browser test also presses the platform's realtime voice shortcut, Cmd+Shift+D on macOS and Ctrl+Shift+D elsewhere, so the whole test runs on a Mac.

## Maintenance review

Test-only change to an upstream spec. With both shortcuts platform-aware the test passes; starting dictation from fullscreen already leaves fullscreen and stays inline, which matches the owner's decision, so no product change was needed. The customizations inventory and README are unchanged.
