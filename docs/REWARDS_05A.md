# Native $MCP rewards — Phase 05-A foundation

Status: accounting foundation only. No mint, no collection, no swaps, no payouts, no signing. Readiness = BLOCKED_NO_NATIVE_MINT.

## Economics (of actually collected, finalized native $MCP creator fees only)
30% SOL to eligible holders · 30% SOL budget to buy $MCP for holders · 40% operations. Integer floors per branch;
remainder (< 10,000 base units) carried to the next receipt. Invariant: sum(allocations) + residual = sum(receipts) (DB-enforced per row and chained).
Child-token 60/25/15 is separate and unchanged.

## Pump evidence (pump-public-docs main, checked 12 Oct 2026; @pump-fun/pump-sdk 4.0.0)
- holderReward=true: creator fee goes to a pump.fun-controlled creator address, "nothing for the creator to claim", pump.fun pays holders, irreversible. Incompatible with MCPX 30/30/40 → native $MCP must be a regular (holderReward=false) SOL-paired coin.
- Collection, no sharing_config: `collect_creator_fee_v2` (curve, lamports from creator-vault PDA [creator-vault, creator] to creator) and `collect_coin_creator_fee` (AMM, WSOL from coin_creator_vault_ata to creator's token account). Both permissionless (anyone can trigger a sweep), both fail once a sharing_config exists.
- With sharing_config: `transfer_creator_fees_to_pump_v2` (AMM → curve vault) + `distribute_creator_fees_v2` (pays shareholders in lamports); shares set once by `update_fee_shares_v2` then admin revoked. Could hard-wire e.g. 60 rewards treasury / 40 operations on chain; the 30/30 inside the 60 stays MCPX-operated.
- Pump coin as quote: Q must be SOL/USDC-paired, not mayhem, not itself pump-quoted. Docs don't state whether a holder-reward Q is eligible → unproven; irrelevant if holderReward=false is chosen. Must be proven on chain before launch.

## Ingest rules
Event id = signature:instruction:event. Credit only finalized events whose program, mint, recipient and asset (SOL) match configuration; everything else quarantined. Wallet balance deltas are never receipts (permissionless sweeps and unrelated transfers). RPC failure = UNKNOWN, never zero. Curve→AMM migration adds the AMM source; both cursors tracked.

## Wallet roles (addresses to be supplied later by the operator; none invented)
Native fee receiver (coin creator or sharing shareholder) · rewards treasury · operations treasury · swap signer · payout signer · admin. Receiver, swap signer and payout signer should be distinct hot keys; operations treasury and admin cold. Must not reuse child 25%/15% recipients or builder keys.

## Proposed (not approved) eligibility
Unique owners aggregated from token accounts at one slot; exclude LP/pool vaults, bonding curve, PDA-owned accounts, protocol treasuries; minimum balance TBD. Entitlements refuse to compute until approved (dry run only).
