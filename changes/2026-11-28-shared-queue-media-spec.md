### Maintenance

- The shared queue browser test for a media edit after another device's change follows the edit hold and the superseded edit recovery.

## Maintenance review

Test only; behavior is unchanged. `shared-message-queue.spec.ts` "preserves a media edit after another device changes the message" opened an editor on a second device while the first device's editor was open. Since #697 the open editor holds the message, so the second device's Edit is refused, no editor opens and the test waited out 180 seconds at the second editor. A probe run showed the refusal is visible: the row reads "Being edited" and an alert says "This message is being edited in another window." The spec now asserts that alert and that no editor opens. It then makes the competing change the way it can still arrive, by releasing the first editor's hold through the daemon client, as a lapsed hold or an older client would, and editing at revision 0. Since #695 the refused save offers "Review against current message" in place of "Could not synchronize", so the spec waits for that action. The rest is unchanged: review, save with the image at revision 2, and the other device shows it. README overview and onboarding are unchanged.
