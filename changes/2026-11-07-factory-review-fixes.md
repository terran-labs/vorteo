### Fixes

- A pinned Factory card stays visible in its project while a sidebar focus hides the Pinned section.
- Sidebar keyboard shortcuts no longer count Factory workspaces, which now appear as chips on the Factory card, so the numbers match the rows on screen.
- Sidebar Factory cards refresh their queue every two minutes only while expanded and the Factory is on. A collapsed card shows its last known stage bar, which keeps GitHub reads on the Foreman's token low.
- The Factory Overview's oldest-queued figure shows "—" for the live queue instead of borrowing sample ages.

## Maintenance review

Fixes from the independent review of the Factory sidebar card and overview designs. Updated the Factory sidebar card inventory entry for pinned cards under focus, shortcut numbering and queue refresh. Interface only; no server, protocol or plugin changes. Source only; not installed. README overview and onboarding are unchanged.
