### Fixes

- Hosted Claude agents now run the Claude Code bundled with the installed release instead of whatever `claude` is on the Host's PATH, so models such as Fable 5.2 no longer fail with an unsupported-version error after the session host starts.
- Starting a Claude agent now refuses, before the CLI launches, a model that the Claude Code it would run is too old for, and names that executable, its version and how to update it.
- Fable 5.2 requires Claude Code 2.1.290, the version Claude Code itself reports, instead of 2.1.321.

## Maintenance review

The session host never initialized the managed Claude CLI selection that daemon workers receive from the supervisor, so every hosted Claude agent launched PATH `claude`. On this Host that was Homebrew's 2.1.285, which refuses Fable 5.2. The host now selects the release's validated CLI when its launchd job starts it through the release link and logs the selection at startup; a source checkout or test harness keeps PATH `claude`, and explicit command overrides are unchanged. A failed packaged-CLI validation still refuses launches instead of falling back, as before. Each launch now checks the requested model's Claude Code floor against the executable it will run, probing and caching that executable's version, so a shared profile or another process can no longer bypass the catalog's gate. The durable sessions entry is updated. Focused tests, typecheck and lint pass. Delivery needs a session-host restart through the tracked lifecycle workflow; a daemon restart alone does not reload the host. README overview and onboarding are unchanged. Not installed.
