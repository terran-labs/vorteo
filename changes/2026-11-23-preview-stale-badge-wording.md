### Fixes

- The out-of-date badge on the Previews gallery now plainly means "not up to date" in Spanish, Portuguese, French, Japanese, Korean and Arabic. The earlier words could read as "latest status", the opposite of what the badge says. Korean's out-of-date sentences now say "last confirmed state" to match (#586).
- A terminal stop that is still being sent holds only its own preview's buttons in the scripts menu and the gallery, as a broker request already did (#586).

## Maintenance review

Review fixes within the same pull request; the inventory entry is unchanged. The scripts button test gains one case table that fails when either per-preview key is removed. The translation change has no test, since a key table cannot check meaning. Interface only. README overview and onboarding are unchanged. Not published.
