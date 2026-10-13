# MCP worker rules

- Single-mint intelligence tools (holder_intelligence, token_risk_analyst) share one bounded collection in services/mcp-worker/src/holders.mjs (≤5 RPC calls, largest-token-accounts coverage only, never the rewards holder index) and one page shell src/components/mcpx/MintToolShell.tsx — so coverage disclosure and error handling stay identical across both.
