### Fixes

- Agent chats render again. The Make this thread the Foreman hook (#360, #625) selected a new object from the session store on every render, so every thread tab re-rendered until React stopped with "Maximum update depth exceeded" and the app showed its error screen instead of the chat. The hook now selects only the thread's project, folder, Foreman label value and archived state, compared shallowly, so an agent update that leaves those unchanged no longer re-renders its tab.

## Maintenance review

Fix for #625 (part of #360), found by the browser suite on the batch with #622 and #625. No inventory entry changes. The existing sidebar hook test now reads the session store with real `useSyncExternalStore` semantics and renders the Make Foreman hook, so a selector that returns a fresh value, or that re-renders on an unrelated agent update, fails in unit tests. README overview and onboarding are unchanged. Interface only; ships with #622 and #625.
