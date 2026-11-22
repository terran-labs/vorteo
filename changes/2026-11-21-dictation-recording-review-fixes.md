### Fixes

- Cancelling dictation by Escape, the voice button or during upload keeps the recording and offers Retry and Discard. Pressing the Cancel dictation button discards a capture shorter than 5 seconds at once and keeps a longer one the same way. Otherwise only Discard, or a non-empty transcript being applied, deletes stored audio.
- An empty final transcript keeps the recording and offers Retry instead of ending silently; a partial transcript is no longer used in its place.
- Retry first cancels any stream the Host may still be transcribing, so a slow finish cannot run two transcriptions of the same recording.
- Pressing Enter in a hidden text field no longer sends a draft while dictation audio is waiting.
- A failed storage write is retried, and a recording missing a segment is never offered back as whole. Storage stays on for later recordings.
- A second browser tab no longer takes over a recording the first tab owns. A composer reused for another thread keeps each thread's audio separate, including the last second of audio that arrives after the switch even when several threads' audio is held in memory or the device cannot store it, and a new dictation waits for the previous thread's microphone to stop, then checks again that no unsent audio arrived before it starts.
- Removing a host deletes the dictation recordings made against it.

## Maintenance review

Updated the dictation recordings entry with the deletion rule, late audio after a thread switch, cross-tab ownership, write failures, host removal and the remaining gaps. Interface only. README overview and onboarding are unchanged.
