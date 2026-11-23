### Features

- In the scripts menu, a preview stop that fails or can't be confirmed now says so as a stop, with the broker's message when it is short plain text, and points to Stop to try again. Before, it would have read as a failed start (#586).
- A preview whose link the broker has withdrawn while its server is still running says "Link withdrawn, but the server is still running." instead of "Stopped", on wide and phone menus. When the broker's report is old, the line states both knowns: "Server is running. Link last known withdrawn, checked at 7:31 PM." (#586).

## Maintenance review

Updated the private workspace previews entry: Stop goes through the broker behind `previewStop`, stop outcomes are worded from the daemon's `preview.restart.mode`, and the script's own lifecycle keeps a withdrawn link from reading as stopped. All strings are in the preview status module, English in every locale until the owner approves them. Cases extend the existing key-level table test. Carries #597's commit. Interface only, after the daemon from #599 is installed. README overview and onboarding are unchanged. Not rendered yet; not published.
