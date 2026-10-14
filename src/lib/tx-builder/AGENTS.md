# Site launch-gate rules

- SOL rehearsal (site): the launch mode is chosen only server-side in src/lib/tx-builder/rehearsal.ts (MCPX_SOL_REHEARSAL + MCPX_SOL_REHEARSAL_CREATOR + session wallet + newest one-use permission row (0027; 0028/0029/0032 each allow exactly one more after the previous is consumed, max four), reserved before signing and SUBMITTED before broadcast); the configured wallet never falls back to $MCP and no one else reaches SOL; the optional buy is a separate MAC-bound transaction in /api/creator/launch-buy — so the rehearsal can never open normal launches.
