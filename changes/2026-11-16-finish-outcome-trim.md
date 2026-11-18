### Maintenance

- Keep stored finish outcomes small: only the fields the notice uses and the response it shows.

## Maintenance review

A deferred finish outcome stored with its subscription now keeps the snapshot's status, title and labels and the last response cut to the notice's existing 4,000-character limit, since every subscription write rewrites one JSON file. A response longer than the limit is delivered after a restart without the usual truncation note. The existing restart assertion now checks the stored shape. README overview, onboarding and the customizations inventory are unchanged.
