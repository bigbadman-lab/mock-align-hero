import { describe, expect, it } from "bun:test";
import { isRehearsalTx, REHEARSAL_RECIPIENTS, REHEARSAL_LAMPORTS_EACH, REHEARSAL_TOTAL_CAP } from "../src/payout-rehearsal";
const D = "2ZrpSo3SmuKnFG69XMEYv2Ew54oKGB2DXPVBAJHBGYx2";
const keys = [D, ...REHEARSAL_RECIPIENTS, "11111111111111111111111111111111"];
const pre = [1e9, 0, 0, 0, 1], each = Number(REHEARSAL_LAMPORTS_EACH);
describe("payout rehearsal", () => {
  it("pays 0.001 SOL to each of 3 wallets, capped at 0.003 SOL", () => {
    expect(REHEARSAL_LAMPORTS_EACH).toBe(1_000_000n); expect(REHEARSAL_RECIPIENTS.length).toBe(3); expect(REHEARSAL_TOTAL_CAP).toBe(3_000_000n);
  });
  it("recognises only an exact deployer-paid rehearsal", () => {
    const post = [pre[0]! - 3 * each - 5000, each, each, each, 1];
    expect(isRehearsalTx({ keys, pre, post, err: null }, D)).toBe(true);
    expect(isRehearsalTx({ keys, pre, post: [...post.slice(0, 3), 2 * each, 1], err: null }, D)).toBe(false);
    expect(isRehearsalTx({ keys, pre, post, err: { x: 1 } }, D)).toBe(false);
    expect(isRehearsalTx({ keys: [keys[1]!, D, ...keys.slice(2)], pre, post, err: null }, D)).toBe(false);
  });
});
