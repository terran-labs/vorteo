### Maintenance

- Added a shared installation setup-guide completion helper for fresh browser contexts; #217 / PR #303 owns the packaged fixture wiring after this helper reaches main. This PR does not change the packaged suite.
- Exposed the existing guide storage reader and writer through an injected backend factory, retaining the AsyncStorage singleton and all current callers.

## Maintenance review

Reviewed the setup-guide storage contract and model. The regression is collected by the app unit test project. The regression uses typed storage adapters and the production storage factory without global patches or module mocks. It checks both the explicit seeding function and serialized registration source, then verifies completed-record behavior through the guide model. It does not prove browser init-script ordering, real recovery-page behavior or absence of click interception. Builds' packaged acceptance remains open on the wired PR #303 head. The storage key, record schema, product behavior, customizations inventory and README overview and onboarding are unchanged.
