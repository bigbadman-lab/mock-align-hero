// Finalized, read-only chain reads for the child-fee keeper. Every failure throws or returns null
// (unknown) — never zero — so the keeper holds instead of guessing.
import { PublicKey } from "@solana/web3.js";
import { PUMP_SDK, bondingCurvePda, feeSharingConfigPda, creatorVaultPda, ammCreatorVaultPda, quoteAta } from "@pump-fun/pump-sdk";
import type { ChildRecord, FinalTx, OnchainChild, TokenBal } from "./child-fees";
import type { RpcCall } from "./pipeline";

const F = { commitment: "finalized" } as const;

async function account(call: RpcCall, addr: string) {
  const r = (await call("getAccountInfo", [addr, { ...F, encoding: "base64" }])) as { value: null | { data: [string, string]; owner: string; lamports: number; executable: boolean } };
  if (!r.value) return null;
  return { data: Buffer.from(r.value.data[0], "base64"), owner: new PublicKey(r.value.owner), lamports: r.value.lamports, executable: r.value.executable, rentEpoch: 0 };
}

export async function readChild(call: RpcCall, c: ChildRecord): Promise<OnchainChild> {
  const mint = new PublicKey(c.mint);
  const sc = await account(call, feeSharingConfigPda(mint).toBase58());
  const bc = await account(call, bondingCurvePda(mint).toBase58());
  const qm = await account(call, c.quoteMint);
  const cfg = sc ? PUMP_SDK.decodeSharingConfig(sc as never) : null;
  const curve = bc ? PUMP_SDK.decodeBondingCurve(bc as never) : null;
  return {
    sharingConfig: cfg ? { mint: cfg.mint.toBase58(), adminRevoked: cfg.adminRevoked, shareholders: cfg.shareholders.map((s) => ({ address: s.address.toBase58(), shareBps: s.shareBps })) } : null,
    curveCreator: curve ? curve.creator.toBase58() : null,
    curveQuoteMint: curve ? curve.quoteMint.toBase58() : null,
    quoteMintOwner: qm ? qm.owner.toBase58() : null,
    graduated: curve ? curve.complete : null,
  } as OnchainChild;
}

async function tokenAmount(call: RpcCall, ata: string): Promise<bigint | null> {
  try {
    const r = (await call("getTokenAccountBalance", [ata, F])) as { value: { amount: string } };
    return BigInt(r.value.amount);
  } catch (e) { return e instanceof Error && /could not find account|Invalid param/i.test(e.message) ? 0n : null; }
}

export const curveVaultOwner = (c: ChildRecord) => creatorVaultPda(new PublicKey(c.sharingConfig)).toBase58();

export async function balances(call: RpcCall, c: ChildRecord) {
  const q = new PublicKey(c.quoteMint), p = new PublicKey(c.quoteTokenProgram), sc = new PublicKey(c.sharingConfig);
  return {
    curveVaultQuote: await tokenAmount(call, quoteAta(creatorVaultPda(sc), q, p).toBase58()),
    ammVaultQuote: await tokenAmount(call, quoteAta(ammCreatorVaultPda(sc), q, p).toBase58()),
  };
}

export async function fetchFinal(call: RpcCall, signature: string): Promise<FinalTx | null> {
  const t = (await call("getTransaction", [signature, { ...F, encoding: "json", maxSupportedTransactionVersion: 0 }])) as any;
  if (!t) return null;
  const tb = (xs: any[] | undefined): TokenBal[] => (xs ?? []).filter((b) => b.owner).map((b) => ({ owner: b.owner, mint: b.mint, amount: BigInt(b.uiTokenAmount.amount) }));
  return { finalized: true, err: t.meta?.err ?? null, slot: t.slot, pre: tb(t.meta?.preTokenBalances), post: tb(t.meta?.postTokenBalances), feePayer: t.transaction.message.accountKeys[0] };
}

export async function finalizedBlockHeight(call: RpcCall): Promise<number | null> {
  try { return (await call("getBlockHeight", [F])) as number; } catch { return null; }
}

export async function mintOwner(call: RpcCall, mint: string): Promise<string | null> {
  const a = await account(call, mint);
  return a ? a.owner.toBase58() : null;
}
export const sharingConfigOf = (mint: string) => feeSharingConfigPda(new PublicKey(mint)).toBase58();
