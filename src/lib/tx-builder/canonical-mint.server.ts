// The official $MCP mint: one row in mcpx_rw_config (also read by Treasury and Worker #3). Short cache, fail closed.
const B58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
let last: { at: number; v: string | null } | null = null;
export async function canonicalMint(): Promise<string | null> {
  if (last && Date.now() - last.at < 15_000) return last.v;
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { data, error } = await (supabaseAdmin as unknown as { from: (t: string) => any }).from("mcpx_rw_config").select("mint").eq("id", 1).maybeSingle();
  if (error) throw new Error("config_unavailable");
  const v = data?.mint && B58.test(data.mint) ? (data.mint as string) : null;
  last = { at: Date.now(), v };
  return v;
}
