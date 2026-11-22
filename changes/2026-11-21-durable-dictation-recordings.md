### Fixes

- Dictation never throws away a recording when sending fails. A timed-out start keeps recording, and any failure while audio exists offers Retry and Discard instead of returning to idle. Starting again while an unsent recording exists brings its Retry and Discard back rather than clearing it.
- Dictation audio is kept on the device until its transcript is confirmed, so a reload, an app kill, a Host restart or leaving the thread no longer loses it. The composer offers the recording back with Retry and Discard. Storage is capped at 128 MB, about 50 minutes of audio, and 14 days, removing the oldest recordings first.
- Retry resends the whole recording on a new stream, paced by the Host's acknowledgements. A Retry pressed while disconnected now waits and resends once the connection returns instead of failing without reaching the Host. A start that times out is cancelled on the Host.

## Maintenance review

Added the dictation recordings entry under Projects, devices and interface. Interface only; no daemon or protocol change. Export of a stored recording and new-agent drafts are not covered yet. README overview and onboarding are unchanged.
