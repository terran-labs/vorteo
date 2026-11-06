### Fixes

- The agent MCP server no longer logs an error for every new Claude agent. Claude CLI 2.1.318 opens with an MCP 2026-07-28 discovery probe, which the server declines so the CLI falls back to the 2025-11-25 protocol the server implements. That expected decline is now a debug message. Any other discovery failure, such as malformed JSON-RPC, is still logged as an error, and a regression test covers both along with the full fallback through a tool call.

## Maintenance review

Agent MCP requests are still served statelessly; the transport setup moved from bootstrap into `serveStatelessAgentMcpRequest` so the test exercises the same configuration. Protocol support is unchanged at the SDK's 2025 revisions. README overview and onboarding are unchanged.
