// Derives launch values from the mint's creation transaction (finalized, read-only):
// anchorSlot = creation slot − 1 (holder index starts empty there), genesisWindow = 5-minute window containing
// creation, deployer = fee payer of the creation tx. Deterministic: the oldest finalized signature never changes.
import type { Rpc } from "./helius-history";

export async function deriveLaunch(rpc: Rpc, mint: string, maxPages = 50): Promise<{ anchorSlot: number; genesisWindow: number; deployer: string; signature: string } | null> {
  try {
    let before: string | undefined, oldest: { signature: string; slot: number } | null = null;
    for (let p = 0; p < maxPages; p++) {
      const page = (await rpc("getSignaturesForAddress", [mint, { limit: 1000, commitment: "finalized", ...(before ? { before } : {}) }])) as { signature: string; slot: number }[];
      if (!Array.isArray(page) || !page.length) break;
      oldest = page[page.length - 1]!; before = oldest.signature;
      if (page.length < 1000) break;
      if (p === maxPages - 1) return null; // could not reach the beginning → never guess
    }
    if (!oldest) return null;
    const tx = await rpc("getTransaction", [oldest.signature, { commitment: "finalized", encoding: "json", maxSupportedTransactionVersion: 0 }]);
    const payer = tx?.transaction?.message?.accountKeys?.[0];
    if (!tx || typeof tx.blockTime !== "number" || typeof payer !== "string") return null;
    return { anchorSlot: tx.slot - 1, genesisWindow: Math.floor(tx.blockTime / 300) * 300, deployer: payer, signature: oldest.signature };
  } catch { return null; }
}
