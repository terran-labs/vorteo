### Fixes

- In the scripts menu, Stop and Restart stay disabled while the broker is still starting or stopping that preview, not only until the request is sent; a second press would only be refused (#586).
- A preview whose link was withdrawn while its server still runs no longer shows a green, healthy mark beside "Link withdrawn"; it shows the plain running mark (#586).
- A broker message quoted after "Couldn't start:" or "Couldn't stop:" now ends with a period when it has none, so the sentence ends (#586).

## Maintenance review

Review fixes from the render pass to the stop wording in the same pull request; the inventory entry is unchanged. Cases extend the existing key-level table and script status tests. Interface only. README overview and onboarding are unchanged. Not published.
