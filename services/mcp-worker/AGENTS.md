# MCP worker rules

- Single-mint intelligence tools (holder_intelligence, token_risk_analyst) share one bounded collection in services/mcp-worker/src/holders.mjs (≤5 RPC calls, largest-token-accounts coverage only, never the rewards holder index) and one page shell src/components/mcpx/MintToolShell.tsx — so coverage disclosure and error handling stay identical across both.
- Multi-tool composition (onchain_report_builder) calls other worker functions in-process with one shared call budget and deadline — never the website relays — so a report is one free test and can't fan out.
