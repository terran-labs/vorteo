### Fixes

- Local dictation no longer stalls behind its own transcription. The on-device recognizer used to decode inside each audio message, so on a busy machine every later message, and every new dictation start, waited for that decode and timed out after 30 seconds. Decoding now runs between messages, one segment at a time, and finished segments are transcribed before live previews. Previews are rationed to at most a third of the speech worker's time and are skipped entirely while a recording is replayed faster than real time.
- A dictation or voice start that hangs on an unresponsive local speech worker now replaces that worker and retries once, instead of reusing it for every later start. A start on a warm worker waits at most 8 seconds, the first start after the worker or its model loads waits 20 seconds, and a start queued behind another session's work keeps the 30 second bound and never kills a worker that is still answering. A session created after its start gave up is closed instead of leaking.
- Local speech failures carry stable codes for the error display: `speech_worker_timeout`, `speech_worker_exited` and `speech_unavailable`. Messages are unchanged.

## Maintenance review

Issue #552 (parent #551). The customizations inventory has no local speech entry, so it is unchanged. Recovery is covered by new cases in the existing worker client tests. README overview and onboarding are unchanged. Source only; installing needs a Host and Dev daemon restart.
