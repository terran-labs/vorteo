### Maintenance

- Agent-initiated `create_agent`, `set_agent_mode`, `update_agent` (mode and features), `switch_agent_profile` and cross-agent `respond_to_permission` now log what the supervisor access ceiling would refuse, without refusing, changing or delaying anything (#530). Each non-allowed evaluation writes one bounded warning, "Access ceiling would refuse", with the operation, both agent IDs, provider IDs and live modes, the comparator's result, reason and escalation codes, the three daemon-asserted inputs and whether the refusal holds even with every assertion in the child's favour. Allowed evaluations log at debug only. Owner actions from the app and top-level sessions are not evaluated. Comparator or logger failures are caught and logged once with a fixed code.

## Maintenance review

Updated the supervisor access table entry: it is now called in report-only mode from five agent tools, with daemon-derived inputs. Who answers a child's prompts is the supervisor and provider configuration is supervisor-writable, because nothing yet changes either; mode authority is established only for the exact `claude` and `codex` provider ids. Caller identity still comes from the agent MCP session's query string (#525). README overview and onboarding are unchanged. Source only; not installed.
