### Tooling

- Lint now refuses relative imports with a `.js` extension in code the app bundles, and any relative value import in shared plugin files. Both broke the web bundle while every existing check passed: Metro cannot resolve `./x.js` for a `.ts` file, Vitest can, and shared plugin files are also loaded by the daemon's Node runtime, which needs the extension.

## Maintenance review

Added `paseo/no-relative-js-extension` (`packages/app/index.ts`, `packages/app/src/**`, `packages/app/modules/**`) and `paseo/no-relative-shared-import` (`plugins/*/shared/**`) to the repository oxlint plugin, with one named exception for the Node-loaded Vitest global setup `websocket-test-global-setup.ts`. Type-only imports stay allowed. The plugin test gains one case table. `packages/app/e2e/` runs in Node and is not covered. The coding standards describe the rule. Repository lint passes with no other changes. README overview and onboarding are unchanged. Not installed; lint only.
