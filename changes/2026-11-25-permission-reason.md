### Fixes

- A Claude tool permission card now says why it appeared and which mode the thread is in. When Claude Code's dangerous-removal safety check stops a command, even in Bypass mode, the card reads "Claude Code's safety check stopped this command because it could not rule out that it deletes files. Bypass mode does not skip this check." with the path it names. A prompt forced by one of the owner's own ask rules says so, and a permission rule that denies a command inside a shell -c script says that; any other prompt shows Claude Code's own reason. Reason, path and title text is flattened to one line and capped. "This thread is in Bypass mode." (or the thread's mode) appears beside it (#659).

## Maintenance review

Issue #659, part A. The Claude provider keeps the SDK's decision reason, blocked path and matched ask rule in the permission request's metadata, passes the SDK's prompt title through, and logs which option keys arrived at debug level. No wire change: title, description and metadata were already optional on permission requests. Two cases in the Claude provider tests cover the measured dangerous-removal options and the flattening and capping; the first awaits the request the session's close rejects, so it leaves no unhandled rejection. No inventory entry changes; README overview and onboarding are unchanged.
