### Tests

- The fullscreen dictation browser test presses the platform's own dictation shortcut, Cmd+D on macOS and Ctrl+D elsewhere, so it runs on a Mac.

## Maintenance review

Test-only change to an upstream spec helper: Control+d never reaches the macOS binding, so local runs could not start dictation. Product behavior, the customizations inventory and README are unchanged.
