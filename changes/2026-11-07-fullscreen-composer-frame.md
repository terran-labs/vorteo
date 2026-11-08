### Fixes

- The fullscreen composer fills the screen on phones and narrow windows again. It had kept its inline height at the bottom while an empty full-screen layer blocked Exit, Send, Queue and Create.
- Fullscreen Send follows the configured queue behavior while an agent runs instead of always sending.
- The New workspace screen gets the same fullscreen editor, without its launch pickers, and its Import session action is back: at the top on phones and under the composer on wide screens.
- On phones the New workspace submit button is labeled Create again instead of Send message.

### Tests

- The footer usage meter tests count requests only after their Settings readiness check, whose Usage pane makes its own.
- The sidebar items order test starts from the registry's plugin ID order, which is deterministic.

## Maintenance review

Reviewed the composer's fullscreen path against upstream after merge 51f16b39f. Vorteo renders the chat composer in the stream columns, so the dock's composer slot received the timeline overlay instead and framed it over the whole viewport; the stream columns now give their composer the dock's fixed frame, and the dock skips an empty slot. The merge also dropped upstream's fullscreen fill and padding overrides from the composer's card stack, replaced the queue-aware fullscreen Send with a plain send, and lost the New workspace layout's dock and import button. Updated the touch access entry in the customizations inventory. Native docks were not changed and still frame their overlay slot; native fullscreen needs separate verification. README overview and onboarding are unchanged.
