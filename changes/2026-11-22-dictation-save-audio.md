### Features

- A failed dictation offers Save audio, which saves the recording as a WAV file without deleting it: through the share sheet on iPhone and the installed web app, as a download in other browsers, and through the share sheet in the native app. The file is prepared while the failure shows, so the press opens the share sheet at once; if saving fails, a notice says so. Save audio always saves the recording of the thread on screen, and recordings over 20 minutes are prepared when pressed, with the button waiting and a notice while that runs; when the file is ready the notice asks for a second press, since the first press can no longer open the share sheet.

### Fixes

- A failed dictation says its recording is kept only once every part of it is on this device; when device storage failed, or writes have not landed after 10 seconds, it says the recording is not saved and the page should stay open until it is sent.
- A notice appears once when this device cannot store recordings, and when an older unsent recording is removed to free space.
- Starting dictation waits for the microphone to finish stopping, so a new recording cannot overlap the end of the previous one, and closing the composer during the microphone permission prompt no longer leaves the microphone on.

## Maintenance review

Updated the dictation recordings entry with Save audio, honest storage notices and the start and stop ordering; removed the export and notice gaps. Interface only. README overview and onboarding are unchanged.
