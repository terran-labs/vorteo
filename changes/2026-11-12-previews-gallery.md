### Features

- Add a Previews gallery. Agents publish web pages, slide decks, images, PDFs and live preview links as frozen versions with thumbnails; you rate them, pick between options with a reason, approve a version and compare versions from a Previews card under the conversation.
- Add browser review. Open a version in your browser, pick an element or region and comment; the comment reaches the authoring thread with the version and location, and agents read all feedback with `get_preview_feedback`.
- Add an injecting reverse proxy that puts the review toolbar on live previews without changing the preview broker, with live reload passed through.

## Maintenance review

New feature in source, not yet installed. Previews adds a protocol file, a server module, daemon routes under `/api/previews`, two agent tools, an app card and a standalone proxy script, with thin hooks in the session, tool catalog, message queue and bootstrap. The inventory gains a Previews entry under Projects, devices and interface and a new guide. Tests cover forged feedback, single-use pairing, snapshot path escapes, retention and proxy passthrough. The README gains one Power Tools paragraph; the overview and onboarding are unchanged.
