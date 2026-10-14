// Server-only persistence for creator sign-in + ownership lookups. Never imported by browser code.
import type { AuthStore, OwnershipStore, OwnedProduct } from "./core";

const admin = async () => (await import("@/integrations/supabase/client.server")).supabaseAdmin;
const fail = (e: unknown) => { if (e) throw new Error("auth_store_unavailable"); };

export const authStore: AuthStore = {
  async insertChallenge(r) {
    const db = await admin();
    // Bounded retention: drop long-expired challenges.
    await db.from("mcpx_auth_challenges").delete().lt("expires_at", new Date(Date.now() - 3600_000).toISOString());
    const { error } = await db.from("mcpx_auth_challenges").insert({ nonce_hash: r.nonceHash, wallet: r.wallet, domain: r.domain, message: r.message, expires_at: r.expiresAt });
    fail(error);
  },
  async consumeChallenge(nonceHash) {
    const db = await admin();
    const { data, error } = await db.from("mcpx_auth_challenges")
      .update({ consumed_at: new Date().toISOString() })
      .eq("nonce_hash", nonceHash).is("consumed_at", null)
      .select("wallet, domain, message, expires_at");
    fail(error);
    const row = data?.[0];
    return row ? { wallet: row.wallet, domain: row.domain, message: row.message, expiresAt: row.expires_at } : null;
  },
  async insertSession(r) {
    const db = await admin();
    await db.from("mcpx_creator_sessions").delete().lt("expires_at", new Date(Date.now() - 24 * 3600_000).toISOString());
    const { error } = await db.from("mcpx_creator_sessions").insert({ token_hash: r.tokenHash, wallet: r.wallet, network: "solana-mainnet", expires_at: r.expiresAt });
    fail(error);
  },
  async getSession(tokenHash) {
    const db = await admin();
    const { data, error } = await db.from("mcpx_creator_sessions").select("wallet, expires_at, revoked_at").eq("token_hash", tokenHash).maybeSingle();
    fail(error);
    return data ? { wallet: data.wallet, expiresAt: data.expires_at, revokedAt: data.revoked_at } : null;
  },
  async revokeSession(tokenHash) {
    const db = await admin();
    const { error } = await db.from("mcpx_creator_sessions").update({ revoked_at: new Date().toISOString() }).eq("token_hash", tokenHash).is("revoked_at", null);
    fail(error);
  },
};

export const ownershipStore: OwnershipStore = {
  async getProduct(creationId) {
    const db = await admin();
    const { data: c, error } = await db.from("mcp_creations").select("id, creator_wallet").eq("id", creationId).maybeSingle();
    fail(error);
    if (!c) return null;
    const { data: p, error: e2 } = await db.from("mcp_product_configs").select("lifecycle_state").eq("creation_id", creationId).maybeSingle();
    fail(e2);
    return { creationId: c.id, creatorWallet: c.creator_wallet, lifecycleState: (p?.lifecycle_state ?? null) as OwnedProduct["lifecycleState"] };
  },
};

/** Products whose verified creator is this wallet (bounded). */
export async function listOwnedProducts(wallet: string) {
  const db = await admin();
  const { data, error } = await db.from("mcp_creations").select("id, slug, display_name, ticker, template_id, child_mint, verified_at").eq("creator_wallet", wallet).order("verified_at", { ascending: false }).limit(50);
  fail(error);
  return (data ?? []).map((r) => ({ creationId: r.id, slug: r.slug, displayName: r.display_name, ticker: r.ticker, templateId: r.template_id, childMint: r.child_mint, verifiedAt: r.verified_at }));
}

export async function listKeyMetadata(creationId: string) {
  const db = await admin();
  const { data, error } = await db.from("mcp_product_access_keys")
    .select("key_id, display_prefix, status, label, created_at, expires_at, revoked_at")
    .eq("creation_id", creationId).order("created_at", { ascending: false }).limit(50);
  fail(error);
  return (data ?? []).map((k) => ({ keyId: k.key_id, prefix: k.display_prefix, status: k.status, label: k.label, createdAt: k.created_at, expiresAt: k.expires_at, revokedAt: k.revoked_at }));
}

/** Separate auth budget ("auth:*") so sign-in attempts can't drain tool quotas, and vice versa. Fails closed. */
export async function takeAuthBudget(request: Request): Promise<boolean> {
  const ip = request.headers.get("cf-connecting-ip") ?? request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
  const data = new TextEncoder().encode(`auth-ip:${ip}`);
  const v = [...new Uint8Array(await crypto.subtle.digest("SHA-256", data))].slice(0, 16).map((x) => x.toString(16).padStart(2, "0")).join("");
  try {
    const db = await admin();
    for (const [bucket, window, limit] of [[`auth:m:${v}`, 60, 10], [`auth:h:${v}`, 3600, 60], ["auth:global", 60, 300]] as const) {
      const { data: ok, error } = await db.rpc("mcpx_rate_limit_take", { _bucket: bucket, _window_seconds: window, _limit: limit });
      if (error || ok !== true) return false;
    }
    return true;
  } catch { return false; }
}
