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

# Phase 05-B additions

## Source of truth (verified on mainnet, finalized)
- Collected fee = Anchor self-CPI event executed by the program with its own event authority
  (Pump: Ce6TQqeHC9p8KetsN6JsjHK7UTZk7nasjjnr7XxXp9F1). Logs and balance deltas are never credited.
- Pump `CollectCreatorFeeEvent` {timestamp, creator, creator_fee, quote_mint} — emitted by both legacy
  `collect_creator_fee` and `collect_creator_fee_v2`. **It carries no coin mint**: the creator vault is per creator,
  pooled across every coin that creator owns. The $MCP fee receiver must therefore be a wallet that never creates
  any other coin, or fees cannot be attributed to $MCP.
- PumpSwap `CollectCoinCreatorFeeEvent` {timestamp, coin_creator, coin_creator_fee, vault_ata, token_account}: paid as WSOL
  into a token account (must be unwrapped to become SOL). Not yet observed with a non-zero amount; its event authority
  (GS4CU59F31iL7aR2Q8zVS8DRrcRnXX1yjQ66TqNVQnaR) is unverified on chain.
- "Nothing to collect" emits no event (logged only) → no zero-amount credits.
- Accrued = creator-vault balance above rent (curve) / vault ATA balance (AMM); claimable = same, anyone may trigger;
  collected = finalized event; ledger-eligible = collected AND recipient/asset/program match the approved config.

## Single recipient vs on-chain 60/40 sharing (not decided, nothing configured)
- Single recipient: flexible, re-pointable by operator process; one hot receiver key; MCPX must split 60/40 itself.
- Sharing config: 60/40 enforced on chain and paid in SOL by anyone calling distribute; `update_fee_shares_v2` is once-only
  (admin revoked) — irreversible; after it, collect_* instructions fail and event source becomes DistributeCreatorFeesEvent
  (decoder not yet built). Needs its own on-chain simulation proof.

## Eligibility v1 (src/lib/rewards/eligibility.ts)
>0 balance, owners aggregated across SPL + Token-2022 accounts at one finalized slot, supply must reconcile exactly.
Excluded: pool vaults, burn, MCPX treasuries/reserves from a versioned config (unapproved → live BLOCKED).
Program-owned / unknown / delegated / frozen holdings → AMBIGUOUS, reviewed per owner, block live payouts.
Historical epochs without a point-in-time index → INVALID (no current-balance approximation).

## State model
Append-only (DB triggers, verified as service role): fee events, allocations, snapshots, snapshot holders, entitlements.
Mutable by design: epochs (trigger-enforced stage order, SETTLED/CARRIED_FORWARD final, no delete), cursors,
swap/payout intents (PLANNED/HELD/CANCELLED only — no approved/executed states exist yet).

## Wallet roles (proposal; no addresses chosen)
| Role | Holds key? | Separate? |
|---|---|---|
| Native fee receiver (coin creator) | hot, signs nothing but receipts | yes — creates no other coin |
| Rewards treasury (60%) | multisig | yes |
| Operations (40%) | multisig/cold | yes; not the child 25% ops wallet unless approved |
| Buyback signer | hot, budget-capped | yes |
| Payout signer | hot, budget-capped | yes |
| Admin / config approver | cold | yes |
Child-token 25% / 15% Phantom wallets stay child-only.

# Phase 05-C — native fee sharing (Option B approved: 6000 rewards / 4000 operations on chain)

## Source of truth for a sharing-config coin (src/lib/rewards/pump-sharing.ts)
- Pump `DistributeCreatorFeesEvent` {timestamp, mint, bonding_curve, sharing_config, admin, shareholders[{address, share_bps}], distributed, quote_mint},
  emitted via Pump's event authority. It carries the TOTAL only; per-shareholder amounts are the System transfers inside the
  same instruction from creator vault PDA ["creator-vault", sharing_config] (Pump) to each listed shareholder.
- Binding: sharing_config must equal PDA ["sharing-config", mint] under Pump Fees (pfeeUx…); vault derived from it; sum of
  vault→shareholder transfers must equal `distributed`; any vault transfer to a non-shareholder → UNKNOWN.
- PumpSwap `transfer_creator_fees_to_pump_v2` emits no event; it is a System transfer AMM vault authority → Pump creator vault,
  recorded as a sweep (vault movement), never a receipt. Funds count once, when distributed.
- Settlement asset for SOL pairs: lamports to shareholder wallets. No WSOL unwrap needed by shareholders.
- Sharing coins never emit CollectCreatorFeeEvent (collect_* fail), so the 05-B decoder cannot double count them.
- Fee classes: accrued = vault balances (curve vault above rent + AMM vault ATA) · swept = AMM→curve vault transfers ·
  distributed = event total · treasury received = verified transfers to each approved shareholder.

## Internal division
Rewards treasury actual lamports L: SOL payouts = floor(L/2), buyback = L − floor(L/2) (odd lamport to buyback). Network fees,
rent and dust are paid from operations/fee reserve, never from holder budgets, and are recorded as separate costs (05-D).

## Native launch atomicity (from 04-B measurements)
create_v2 + create_fee_sharing_config = 1,108 bytes (simulated PASS). Adding update_fee_shares_v2 (6000/4000) = ~1,406 bytes
without a lookup table → too large; needs an ALT (~944–1,190 bytes). Until all three run in ONE transaction, a window exists
where the coin trades with the creator as 100% shareholder → native launch BLOCKED. Alternative under review: create coin with
creator = a fresh wallet whose only possible fee distribution goes to itself, then … still leaves a window → rejected.
Checklist: regular SOL pair, holderReward=false, mayhem=false, two approved treasuries, ALT provisioned, full atomic simulation,
fee decoder live against the real mint, snapshot index running, exclusion list approved, $MCP quote eligibility proven.

## Treasury roles (no addresses chosen)
MCPX_NATIVE_REWARDS_TREASURY (60%) and MCPX_NATIVE_OPERATIONS_TREASURY (40%) are receive-only shareholders (can be multisig vaults —
transfers are plain lamport sends). Separate signers: creator/launch key (one-time, then retired), buyback signer, payout signer
(hot, capped per window, funded from rewards treasury by multisig top-up), admin (cold / multisig). Two Phantom wallets plus one
multisig suffice; child 25%/15% wallets are not reused.
