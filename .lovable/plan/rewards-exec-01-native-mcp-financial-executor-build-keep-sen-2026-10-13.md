# REWARDS-EXEC-01 — Native $MCP financial executor (build, keep sending off)

Goal: build the complete automated executor for $MCP rewards on the existing rewards worker and deployer wallet. Collect fees, unwrap, buy back, and pay holders in SOL and $MCP. Everything gets built and tested, but nothing is broadcast, minted or spent. Sending stays switched off in this gate only because it hasn't been proven on-chain yet. Turning it on later is a code-level step after a separately approved micro-transaction rehearsal, not a permanent switch.

## E00 audit (done before writing this plan)

Reusable as-is:
- The site connection: sealed batches run in one transaction, and the worker has no database login.
- Fee-event decoding, holder history, finalized-slot snapshots, the 30/30/40 ledger and the window processor.
- The signer: key check, allowlisted programs, exact-match SOL and token payouts.
- Fee-backed budgets: migration 0018 is applied.
- The payout-record state machine: migration 0017 is applied.

Missing or contradicting the brief:
1. Payout records hold the signature only, not the signed transaction bytes. A crash after sending can't safely resend the same bytes. There is also no "sent" state between signed and landed.
2. Fee collection, unwrapping and buybacks can't be signed (refused as PATH_NOT_PROVEN). Only curve collection and curve buyback are assembled.
3. PumpSwap fee collection and PumpSwap buyback are not built. The SDK is installed but unused.
4. There is no broadcast, confirmation or reconciliation code anywhere.
5. Recording buyback fills exists in the database, but no code writes them.
6. The worker's main loop plans windows but never runs an execution cycle.
7. Mint onboarding doesn't check the token program, Pump coin, creator-fee recipient or SOL pairing.
8. The worker package description still says "no signing" (out of date).

## Build steps

**E01 — Fee collection, both stages.** Curve and PumpSwap collection go through the pinned SDKs, with program IDs checked against the live chain. Income is counted only from finalized, attributed Pump events. The existing unwrap rule stays: it closes only the exact accounted wrapped-SOL amount. If the PumpSwap pieces can't be proven read-only, that one step is marked BLOCKED.

**E02 — Buyback, both venues.** Curve buys, plus PumpSwap buys on the canonical pool only. Checks: the pool, mint and program; a fresh quote; slippage of 500 basis points or less; a minimum output; and the budget. The real fill is read from the finalized token-balance change and recorded through the bridge. Only tokens actually received can fund $MCP payouts.

**E03 — Payouts.** The existing SOL and Token-2022 builders are kept. New: deterministic batch IDs, the excluded-wallet list (deployer, burn address, pool vaults; any uncertainty pauses), dust carried forward, and checks that each recipient actually received their amount after settlement.

**E04 — Executor.**

```text
reserve -> build -> validate -> sign -> SAVE signed bytes -> send -> poll -> finalized proof -> LANDED
                                          crash here = resend the same bytes; a new signature is never made
```

- Every operation type gets its own record: collect, unwrap, buy, SOL payout, $MCP payout.
- Expiry needs a finalized block height above the transaction's last valid height and no signature on chain.
- Batches that already settled stay settled.
- A wallet-balance check covers all open operations plus the 40% reserve.

**E05 — Automatic cycle.**
- After each sealed window, the worker runs collect, unwrap, buy, then pay.
- One lease at a time; runs that fall behind catch up automatically.
- Mint onboarding checks run before any tracking starts.
- Having a mint set never makes execution ready.

**E06 — Evidence and tests.**
- Read-only mainnet simulations on existing Pump coins, saved to `docs/evidence/exec01-*.json`.
- Throwaway-database tests through the real sealed bridge: two workers racing, and crashes at every step.
- Error cases: ambiguous RPC answers, expired blockhashes, duplicate events, graduation, short reserve, bad exclusion lists, ATA failures, wrong mint, wrong fee wallet.
- Regression run of the full test suite.

## Approval points (I stop at each)

1. **Migration 0019** (additive, website server only). Saved to `docs/pending-migrations/` and not applied until you approve. It adds to payout records:
   - the signed transaction bytes, stored before sending
   - the time each send happened
   - a new SUBMITTED state (Signed → Submitted → Landed / Failed / Expired)
   - each operation's kind and the batch it belongs to
2. **Render redeploy** of the rewards worker only. Sending stays off.
3. **Micro-transaction rehearsal.** A separate brief.

## Technical details

New worker files: `collect.ts`, `swap.ts`, `executor.ts` (state machine plus an injectable sender), `onboard.ts`. Broadcasting is built behind `sender = null` in this gate, so the code is complete and tested with a fake sender.

The signer's allowlist expands per kind (Pump, PumpSwap, the fee program). Each kind gets its own check of instructions, accounts and amounts.

New tests:
- `src/test/rewards-exec01-*.test.ts` (throwaway Postgres plus the bridge handler)
- `services/rewards-worker/test/exec.test.ts`

The child-token builder (#2), the MCP worker (#1), the website tools, bring-your-own-key and MCP are untouched, and the 60/25/15 child-token split is never read by the rewards worker.

Final report in the brief's PASS/PARTIAL/BLOCKED format. Expected result: **PARTIAL**. Real settlement can't be proven before the micro-transaction rehearsal and the actual $MCP mint, so native rewards and child fee models will both report as not yet PRELAUNCH_READY until then.
