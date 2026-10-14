import { B58 } from "./core";
import { getChildEcosystem, getDistributions, getOverview, getWindows } from "./source.server";

const H = { "content-type": "application/json", "cache-control": "public, max-age=10, s-maxage=15, stale-while-revalidate=30", "x-content-type-options": "nosniff" };
const bad = (e: string) => new Response(JSON.stringify({ error: e }), { status: 400, headers: { ...H, "cache-control": "no-store" } });

export async function treasuryReply(request: Request, view: "overview" | "windows" | "distributions" | "child-ecosystem"): Promise<Response> {
  const u = new URL(request.url);
  try {
    let body: unknown;
    if (view === "overview") body = await getOverview();
    else if (view === "child-ecosystem") body = await getChildEcosystem();
    else if (view === "windows") {
      const range = u.searchParams.get("range") ?? "24h";
      const before = u.searchParams.get("before") ?? undefined;
      if (!["24h", "7d", "all"].includes(range) || (before && Number.isNaN(Date.parse(before)))) return bad("invalid_input");
      body = await getWindows(range as "24h", before ? new Date(before).toISOString() : undefined);
    } else {
      const asset = u.searchParams.get("asset") ?? undefined;
      const wallet = u.searchParams.get("wallet") ?? undefined;
      const b = u.searchParams.get("beforeSlot");
      if ((asset && asset !== "SOL" && asset !== "MCP") || (wallet && !B58.test(wallet)) || (b && !/^\d{1,15}$/.test(b))) return bad("invalid_input");
      body = await getDistributions({ asset: asset as "SOL" | undefined, wallet, beforeSlot: b ? Number(b) : undefined });
    }
    return new Response(JSON.stringify(body), { status: 200, headers: H });
  } catch {
    return new Response(JSON.stringify({ error: "unavailable" }), { status: 503, headers: { ...H, "cache-control": "no-store" } });
  }
}
