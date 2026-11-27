### Fixes

- An approval's owner escalation is now re-sent for the thread as it is at that moment, and question requests keep passing through a pending-list refresh unchanged (#659).

## Maintenance review

Follow-up within #667 for issue #659: the escalation timer looks up the live agent by id before emitting, and the pending-list adoption leaves question-kind requests untouched, as before part C. Found by CI under load. No inventory entry changes; README overview and onboarding are unchanged.
