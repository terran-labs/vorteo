### Maintenance

- The queue recovery browser test follows the current recovery path for an edit whose message left the queue.

## Maintenance review

Test only; behavior is unchanged. `queue-recovery-card.spec.ts` clicked "Keep local copy and continue queue" on an unsynchronized edit refused with `delivery_conflict` for a message no longer in the queue. Since #695, such an edit counts as superseded and offers "Send my edit as a new message" or "Discard my edit" instead, so the button never appears and the test timed out. In this scenario nothing is left unrecoverable. Send now is disabled while any local record is not dismissed, and both offered actions remove the record, which enables it again. The only capability lost is parking the edit locally without sending or discarding it, which #695 replaced on purpose. The spec now checks that both actions are offered, discards the edit, and expects send now to be enabled. README overview and onboarding are unchanged.
