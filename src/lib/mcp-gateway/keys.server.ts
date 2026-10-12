// Server-only key store + issuance/revocation. Reached only from /api/creator/products after a verified
// session AND verified-creator ownership check (or operator tooling).
import { generateProductKey, readPepper, type KeyStore, type StoredKey } from "./keys";

export const productionKeyStore: KeyStore = {
  async findByVerifier(verifier) {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data, error } = await supabaseAdmin
      .from("mcp_product_access_keys")
      .select("key_id, creation_id, status, expires_at, revoked_at")
      .eq("verifier", verifier)
      .maybeSingle();
    if (error) throw new Error("key_store_unavailable");
    return data
      ? { keyId: data.key_id, creationId: data.creation_id, status: data.status as StoredKey["status"], expiresAt: data.expires_at, revokedAt: data.revoked_at }
      : null;
  },
};

export interface IssueRequest {
  creationId: string;
  actorKind: "operator" | "creator"; // "creator" only after verified session + ownership check
  actorRef: string;
  idempotencyKey: string;
  label?: string;
  expiresAt?: string;
  rotateKeyId?: string;
}

/**
 * Issues a key atomically in the database (optionally revoking the rotated key in the same transaction).
 * Returns the plaintext exactly once; a replayed idempotency key returns the existing id with plaintext null.
 */
export async function issueProductKey(req: IssueRequest): Promise<{ keyId: string; plaintext: string | null }> {
  const pepper = readPepper();
  if (!pepper) throw new Error("not_configured");
  const k = await generateProductKey(pepper, req.creationId);
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { data, error } = await supabaseAdmin.rpc("mcpx_issue_product_key", {
    _creation_id: req.creationId, _verifier: k.verifier, _display_prefix: k.displayPrefix,
    _expires_at: req.expiresAt ?? null, _label: req.label ?? null, _actor_kind: req.actorKind, _actor_ref: req.actorRef,
    _idempotency_key: req.idempotencyKey, _rotate_key_id: req.rotateKeyId ?? null,
  } as never);
  if (error || typeof data !== "string") throw new Error("issue_failed");
  const { data: row } = await supabaseAdmin.from("mcp_product_access_keys").select("verifier").eq("key_id", data).maybeSingle();
  return { keyId: data, plaintext: row?.verifier === k.verifier ? k.plaintext : null };
}

export const revokeProductKey = (creationId: string, keyId: string, actorRef: string) => revokeProductKeyAs(creationId, keyId, "operator", actorRef);

export async function revokeProductKeyAs(creationId: string, keyId: string, actorKind: "operator" | "creator", actorRef: string): Promise<boolean> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { data, error } = await supabaseAdmin.rpc("mcpx_revoke_product_key", { _creation_id: creationId, _key_id: keyId, _actor_kind: actorKind, _actor_ref: actorRef });
  if (error) throw new Error("revoke_failed");
  return data === true;
}
