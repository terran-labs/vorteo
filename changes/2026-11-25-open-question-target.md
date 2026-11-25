### Fixes

- "Open" on a question in the sidebar's Open questions card now lands on that question: the thread opens with its Open questions card expanded and the question highlighted, and the conversation scrolls to where it was asked, loading older history when needed. Each question has its own Open. When the place cannot be found, the thread says "Couldn't find where this question was asked in the conversation." instead of showing the latest message (#660).

## Maintenance review

Issue #660. The daemon records the thread's latest timeline position on a new question as an optional `askedSeq` (wire-compatible; older questions have none and show the notice). The app keeps a one-shot conversation target, highlights the targeted question, and jumps to the last loaded item at or before that position through the same history fetch the chat outline uses, without depending on the outline being shown. Tests: the question model records the position, and opening a question records a target carrying its id and position. No inventory entry changes; README overview and onboarding are unchanged.
