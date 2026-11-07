### Features

- The Factory Overview zooms out to every Factory in the installation at `/h/<host>/factory`, and back into one project. All Factories lists each Factory with its state, stage counts and what needs the owner, puts every issue on one board with a project tag, adds up the reports, and gives the Ledger rail a project filter. A project's overview links back to All Factories.
- A Needs you panel gathers everything waiting on the owner: open questions from Factory threads, instruction proposals and reviews, a stop in effect, issues labelled for human review, failing checks outside repair, claims held by another installation, pull requests waiting for approval and blocked issues, most urgent first. Each row opens the thread, issue, pull request or instructions, or resumes. In All Factories it sits at the top of the page.
- A Stop all Factories switch, apart from a project's Pause, asks for confirmation and then pauses every Factory on the shown hosts: running turns finish, and no new Factory work starts or merges until Resume all. While a stop holds Factories, a banner shows its reason, age and Resume all.
- Sample factory mode covers All Factories with three sample Factories, one paused.

## Maintenance review

Factory Overview command center, interface only: it uses the existing `factory.project.list`, `pause_all` and `resume_all` RPCs and shares the sidebar card's query keys. New route `app/h/[serverId]/factory/index.tsx`, `screens/factory/routes.ts` (`allFactoriesOverviewRoute`) and pure `screens/factory/all-factories-model.ts`. One test covers needs-you ordering and stage aggregation. README overview and onboarding are unchanged. Not installed.
