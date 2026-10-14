// Static MCPX lookup-table manifest (browser + server safe). The 13 addresses are the launch-independent
// accounts produced by services/transaction-builder/scripts/alt-create.mjs `static` (dry run verified
// against mainnet, 2026-10-14). Mint-dependent entries are added later with `extend`.
export const ALT_AUTHORITY = "2ZrpSo3SmuKnFG69XMEYv2Ew54oKGB2DXPVBAJHBGYx2";
export const ALT_PROGRAM_ID = "AddressLookupTab1e1111111111111111111111111";

export const STATIC_ALT_ENTRIES: readonly { address: string; role: string }[] = [
  { address: "11111111111111111111111111111111", role: "System program" },
  { address: "13ec7XdrjF3h3YcqBTFDSReRcUFwbCnJaAQspM4j6DDJ", role: "Protocol account (owned by MAyhSm…)" },
  { address: "4wTV1YmiEkRvAtNtsSGPtUrqRYQMe5SKy2uB4Jjaxnjf", role: "Pump Global" },
  { address: "6z6GDdfb2AjR9ZhJmAUQ5cipJCVxQvLJhB2H8mCwTFBP", role: "Protocol account (owned by Pump)" },
  { address: "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL", role: "Associated Token program" },
  { address: "BwWK17cbHxwWBKZkUYvzxLcNQ1YVyaFezduWbtm2de6s", role: "Protocol account" },
  { address: "Ce6TQqeHC9p8KetsN6JsjHK7UTZk7nasjjnr7XxXp9F1", role: "Pump event authority" },
  { address: "D6QxXDt6hhcCpto4HiZKkN2YQ2iZRF5R7S3caCHpUsML", role: "Pump fee-program event authority (no account — normal)" },
  { address: "GS4CU59F31iL7aR2Q8zVS8DRrcRnXX1yjQ66TqNVQnaR", role: "Protocol account" },
  { address: "MAyhSmzXzV1pTf7LsNkrNwkWKTo4ougAJ1PPg47MD4e", role: "Program attached to every Pump launch" },
  { address: "TSLvdd1pWpHVjahSpsvCXUbgwsL3JAcvokwaKt1eokM", role: "Protocol account" },
  { address: "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb", role: "Token-2022 program" },
  { address: "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA", role: "PumpSwap AMM program" },
];

export type ExistingTable = { address: string; entries: number; active: boolean; frozen: boolean; lastExtendedSlot: number; hasAllStatic: boolean };

/** Resume rule: never create a second table while one owned by the authority exists. */
export function nextAltStep(tables: ExistingTable[] | null): { step: "check_failed" | "create" | "extend" | "done" | "conflict"; table?: string } {
  if (tables === null) return { step: "check_failed" };
  const live = tables.filter((t) => t.active && !t.frozen);
  if (live.length > 1) return { step: "conflict" };
  if (live.length === 0) return tables.length ? { step: "conflict" } : { step: "create" };
  const t = live[0]!;
  return t.hasAllStatic ? { step: "done", table: t.address } : { step: "extend", table: t.address };
}
