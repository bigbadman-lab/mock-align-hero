# $MCP go-live runbook (child launches)

Everything below is built. Each step that touches the chain or a live switch needs explicit approval.

## 1. Mint $MCP (deployer wallet)
Record the canonical mint address.

## 2. Lookup table (deployer wallet 2ZrpSo3… owns + pays)
On the operator's own machine, in `services/transaction-builder` (keypair is read only with `--send`):
```
OPS=5MzN9A2h4w4RdYvwDXUv8ssvJiPPJa9bnamh6yMWFqh5
PLAT=CqaJhS4BKK791cv2fSsbbc75difqCrTiwkzeeR8WqJVB
# Now, before $MCP: 13 launch-independent addresses
node scripts/alt-create.mjs static $OPS $PLAT                                  # dry run
node scripts/alt-create.mjs static $OPS $PLAT <deployer.json> <RPC> --send     # create (approval)
node scripts/alt-create.mjs verify <TABLE>                                     # read-only check
# After LIVE <MCP_MINT>: add mint + bonding curve (2; 5 if migrated to a pool)
node scripts/alt-create.mjs extend <TABLE> <MCP_MINT> $OPS $PLAT               # dry run
node scripts/alt-create.mjs extend <TABLE> <MCP_MINT> $OPS $PLAT <deployer.json> <RPC> --send
```
Never freeze the table. Set `MCPX_LOOKUP_TABLE` on Builder #2 only after `extend` reports `EXTENDED_AND_VERIFIED`.
Recorded table address: _(pending creation)_

## 3. Accept the canonical mint
| Where | Setting |
|---|---|
| Builder #2 | `MCPX_QUOTE_MINT=<MCP_MINT>`, `MCPX_LOOKUP_TABLE=<table>` → redeploy, `/ready` shows quote + lookupTable configured |
| Website (database) | native rewards config mint = `<MCP_MINT>` (the single native go-live step; Treasury leaves pre-launch) |
| Rewards Worker #3 | `MCPX_LAUNCH_VERIFIER=1`, redeploy current revision |

## 4. Switch launches on (website)
`MCPX_CHILD_LAUNCH_ENABLED=1` — Launch button becomes available (prepare + safety check only).
`MCPX_CHILD_LAUNCH_SIGNING=1` — creator wallet signs, site broadcasts, claim filed for verification.
`MCPX_LAUNCH_VERIFIER=1` — required for signing (a sent launch is always tracked).
Optional: `MCPX_SOLANA_RPC_URL` (private RPC for broadcasting; defaults to public mainnet).

## 5. Rehearsal
One real child launch with a test token; confirm "Your token is live" appears and links to `/mcp/<slug>`.
