### Features

- System opens with a Health list: one row per problem, with its current status and a Fix button that jumps to the control that resolves it, or one quiet All good row. The sidebar's System needs attention button counts the same rows and lands on the list.
- Settings has two groups under ruled headings. This device holds Interface, which now includes the former Notifications & privacy panes. Vorteo holds General, Providers, Agents, Voice, Projects & integrations and System, and Environments is now a group inside System. Old addresses still open the right place.
- Each environment is one row whose Edit button opens its full settings in a dialog, with environment exceptions in a collapsed group.
- The owner lock is a Locked and Unlocked radio group at the top of the Settings sidebar.
- Providers are flattened into one card with Move up and Move down buttons. A provider whose only connection is signed out shows Connect beside its switch, and Reconnect N expired walks through every expired connection.
- The connect and reconnect dialog keeps one status line that changes in place, puts links and codes in copy fields, and never shifts between steps.
- Lists longer than five items collapse into a summary row with a Manage dialog.
- Device groups such as Theme, Fonts, Layout, Chat, Sending, Editor, Terminal, Files and Open location have their own Reset button.
- Rarely used controls sit in one collapsed Advanced group per section; searches and jumps open it.
- The installation name saves on Enter or when the field loses focus.
- Data saving is automatic from the browser's signals. The startup screen's Enable data saver is the only manual override, and Follow browser in Settings > Interface > Fonts clears it.
- The browser demo simulates a Demo Lab installation, so installation-wide settings show sample data.

### Improvements

- Settings is denser on desktop, its sidebar is narrower, and Back and search share one short row.
- Settings search is a combobox with announced results, and every jump from the sidebar, search or a Fix button moves keyboard focus to its target.
- Host, Dev and Updates in System are each one compact row.
- Pane headers no longer repeat "This device" beside every group.
- Turning off Check usage hides the sidebar footer meter for that host and stops its polling.
- Shared controls expose selected, expanded, checked and busy state on web; dialogs are named; the segmented control is a radio group; the off switch has a border; text fields link their label, hint and error.
- Starship's light accent is #0a5fbd, with white text on it.

### Fixes

- Jump links keep working after System needs attention or a drill-in page: each page now finds only its own elements.
- System no longer leaves an empty band at the bottom of the page or under the Host card.
- Section headers stay on one line.
- Locked settings no longer leave Health on Checking forever.
- Removed controls that did nothing: the sidebar History, Schedules and Usage switches, usage window pins, the Usage modal, the unused profile editor and the hidden Show setup again row.

### Known limitations

- The System needs attention button counts provider, primary connection and update rows only after Health has rendered once in a session.
- The single Connect shortcut covers Claude and Codex account types.
- The daemon still answers the provider usage list while usage is off.
- End-to-end specs were updated by reading the code and were not run for this change.
- Extra-muted text in Midas, Scriptorium and Ember, and the accent as small text in Midas and Ember, remain below the contrast the accessibility audit asks for.

## Maintenance review

Settings round 5 reworked Settings structure, navigation, owner lock, providers, connect dialog, environments, lists, skills, plugins, sidebar items, usage, data saving, themes, demo and shared control accessibility. The inventory entries for settings navigation and search, System status, owner access, provider management, usage, the skill library, themes and the demo are updated, and new entries cover the sign-in dialog, sidebar items, automatic data saving and accessible settings controls. The README updates its data saving and settings Power Tools items; onboarding is unchanged. The plugin, skill library and Unistyles guides name the new Environments location and data saving behavior. An older Browser data saver bullet in the inventory's historical review area still describes the removed switch and was left as written.
