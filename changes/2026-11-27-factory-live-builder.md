### Maintenance

- A development daemon claimed a private scratch issue, opened a Builder and resumed that Builder after a daemon restart. The plan reader now accepts a closing paragraph after the planned files.

## Maintenance review

The live run uncovered a startup race while providers loaded and a plan parser that mistook a closing paragraph for a file. The isolated run has verified intake, the claim, the plan and the go. The review and merge still need live verification.
