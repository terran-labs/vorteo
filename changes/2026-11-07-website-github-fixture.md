### Tests

- The website browser tests serve GitHub release and star data from their local fixture server, so CI's shared GitHub rate limit no longer breaks the agents and download pages mid-run.

## Maintenance review

Reviewed the website's GitHub lookups. Every page's root loader reads the releases list and star count, and the local preview has no KV cache, so each test page load called the unauthenticated GitHub API; a rate-limited runner failed the root loader and with it unrelated specs such as the agents and download thanks tests. The lookups now take their API origin from the cache context, set by an optional GITHUB_API_URL binding that defaults to api.github.com, and the Playwright config points it at the existing registry fixture server. Production behavior is unchanged; the customizations inventory and README need no updates.
