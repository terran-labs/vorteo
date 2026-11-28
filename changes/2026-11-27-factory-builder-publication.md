### Maintenance

- The standalone Lean Factory can publish a Builder's approved file changes to its issue branch and open its pull request. The daemon checks the expected branch head and records the publication so it can recover an interrupted attempt.
- The fixed primary uses the worker account picker. When the Builder and Reviewer use the same provider, Builder starts must leave ten percentage points of quota above the usual floor.

## Maintenance review

The merge gate requires recorded account eligibility to accept a same-account review. Installed owner promotion and rollback remain unavailable until the Host can verify the owner's release action.
