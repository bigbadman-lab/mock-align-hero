// Creator-facing child-fee distribution status. Only finalized, proven distributions count as
// "confirmed"; signed-but-unproven work is "pending"; everything else is honest "not available".
export type ChildFeeIntentView = { status: "RESERVED" | "SIGNED" | "LANDED" | "FAILED" | "EXPIRED"; distributedAmount: string | null };
export type ChildFeeStatus =
  | { state: "NOT_LIVE"; text: string }
  | { state: "NO_DISTRIBUTIONS"; text: string }
  | { state: "SUMMARY"; pending: number; confirmed: number; confirmedTotal: string; text: string };

export function childFeeStatus(live: boolean, intents: ChildFeeIntentView[] | null): ChildFeeStatus {
  if (!live) return { state: "NOT_LIVE", text: "Child creator-fee sharing — Design intent / not live" };
  if (!intents || intents.length === 0) return { state: "NO_DISTRIBUTIONS", text: "No confirmed fee distributions yet" };
  const pending = intents.filter((i) => i.status === "RESERVED" || i.status === "SIGNED").length;
  const landed = intents.filter((i) => i.status === "LANDED" && i.distributedAmount !== null);
  const total = landed.reduce((a, i) => a + BigInt(i.distributedAmount as string), 0n);
  return { state: "SUMMARY", pending, confirmed: landed.length, confirmedTotal: total.toString(), text: `${landed.length} confirmed distribution(s); ${pending} pending onchain proof` };
}
