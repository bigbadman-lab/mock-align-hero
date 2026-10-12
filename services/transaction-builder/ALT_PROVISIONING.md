# MCPX address lookup table — provisioning plan (NOT executed)

Nothing in this document has been done on chain. It needs separate operator approval.

## Why
The fee-secured creation (`create_v2 → create_fee_sharing_config → update_fee_shares_v2`) is ~1406–1464
bytes as a v0 transaction without a lookup table (limit 1232). With an MCPX table of launch-independent
accounts it is ~944–1002 bytes (typical metadata) and ~1190 bytes with the longest allowed metadata.

## Exact list
Generate it, read-only, once the real `$MCP` mint exists:

```
node scripts/alt-plan.mjs <MCP_MINT> <OPS_RECIPIENT> <PLATFORM_RECIPIENT> <RPC_URL>
```

Measured with a stand-in parent (`dEDUsz…pump`, active curve, Token-2022): **15 entries** — system,
ATA, Token-2022 and pump-amm program accounts; pump Global, pump event authority, pump-fees event
authority; the parent mint and parent bonding curve; and 6 further protocol accounts the SDK attaches to
every create/fee-sharing call. The parent-specific entries change if `$MCP` migrates to a pool, so the
table must be **extended (not frozen)** at that point and the plan re-run.

## Cost (measured via RPC, read-only)
- Rent-exempt deposit for 15 entries: **3,373,120 lamports (~0.00337 SOL)**; refundable only by deactivating then closing.
- Transaction fees: 5,000 lamports per signature × 2 transactions (create, extend) = 10,000 lamports, plus any priority fee.

## Operator steps (after approval)
1. Choose a dedicated authority wallet (not a fee recipient; never on the website or builder).
2. `AddressLookupTableProgram.createLookupTable({ authority, payer, recentSlot })` — send, confirm.
3. `extendLookupTable` with the exact list from `alt-plan.mjs` — send, confirm.
4. Wait at least one slot (warm-up), then read the table and compare entries byte-for-byte with the plan.
5. Set `MCPX_LOOKUP_TABLE` on the builder only. `/ready` then reports `lookupTable: CONFIGURED`.
6. Do **not** freeze while `$MCP` can still migrate; never deactivate while launches may be in flight.
