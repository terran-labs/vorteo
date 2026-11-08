### Security

- Website browser tests no longer copy the whole process environment, which can hold tokens, into the preview build's .dev.vars. Only the registry and GitHub API addresses the tests need reach the test Worker, as plain vars.

## Maintenance review

Reviewed how the website test server passes bindings. CLOUDFLARE_INCLUDE_PROCESS_ENV made the Cloudflare Vite plugin write every process variable into dist/server/.dev.vars; dist is gitignored and no CI workflow uploads it (the only artifact from the job that runs these tests is the server stack tarball, which excludes the website), so no artifact exposure was found. The tests now pass an allowlisted JSON value that vite.config.ts turns into Worker vars, and set CLOUDFLARE_INCLUDE_PROCESS_ENV to false. One unit test drives Wrangler's own dev-vars loader with a canary secret in the environment, under the testing budget's security-boundary allowance. Deploy builds set no test vars and are unchanged. The customizations inventory and README need no updates.
