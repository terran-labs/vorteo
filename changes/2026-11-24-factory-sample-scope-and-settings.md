### Improvements

- The Factory overview's scope selector now lists Sample Factory, its own page of sample data where every control is off and changes nothing. The Live and Sample switch is gone, and All Factories always shows live data (#638).
- Each live Factory has a settings gear at the top right. It opens that Factory's settings: where its home is, the models for each issue stage and where issue agents run, each role's model and instructions, and the role assignments. These moved there from the overview's "Models & roles" disclosure. State, Pause, Resume and Planning stay on the overview. The owner-only lock from #360 still applies to every change.
- A Factory page whose host is offline now says the plugin host is offline, as other plugin pages do, instead of loading until the host reconnects.

## Maintenance review

Issue #638, stacked on #641. Interface only: new routes for the Sample Factory and Factory settings, no daemon or wire changes. The remembered Sample choice is no longer read. The Factory overview browser spec now covers the Sample Factory scope, All Factories without sample data, and changing a stage model in settings and changing it back. Updated the Factory Overview inventory entry; README overview and onboarding are unchanged.
