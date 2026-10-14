// Server-only: pin immutable launch artifacts (artwork + metadata JSON) to public IPFS via Pinata.
// The JWT never leaves the server. Failure returns null so the caller falls back to the mcpx.fun URL.
export const DEFAULT_GATEWAY = "white-acute-buzzard-685.mypinata.cloud";

export const pinataGateway = () => (process.env["PINATA_GATEWAY"] || DEFAULT_GATEWAY).replace(/^https?:\/\//, "").replace(/\/+$/, "");
export const pinataEnabled = () => !!process.env["PINATA_JWT"] && process.env["MCPX_PINATA"] !== "0";
export const gatewayUrl = (cid: string) => `https://${pinataGateway()}/ipfs/${cid}`;
const CID = /^(Qm[1-9A-HJ-NP-Za-km-z]{44}|b[a-z2-7]{20,100})$/;

export async function pinBytes(bytes: Uint8Array, name: string, type: string): Promise<string | null> {
  if (!pinataEnabled()) return null;
  try {
    const form = new FormData();
    form.append("network", "public");
    form.append("name", name);
    form.append("file", new Blob([bytes as Uint8Array<ArrayBuffer>], { type }), name);
    const res = await fetch("https://uploads.pinata.cloud/v3/files", {
      method: "POST", headers: { Authorization: `Bearer ${process.env["PINATA_JWT"]}` }, body: form, signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) { console.error(`pinata upload failed [${res.status}]: ${(await res.text()).slice(0, 300)}`); return null; }
    const j = (await res.json()) as { data?: { cid?: string } };
    const cid = j.data?.cid;
    if (!cid || !CID.test(cid)) { console.error("pinata upload returned no valid cid"); return null; }
    const url = gatewayUrl(cid);
    // Warm the gateway so Pump.fun / wallets get a fast first read.
    fetch(url, { method: "GET", signal: AbortSignal.timeout(5_000) }).catch(() => {});
    return url;
  } catch (e) { console.error("pinata upload error", e instanceof Error ? e.message : "unknown"); return null; }
}

/** True for https://<our gateway>/ipfs/<cid> with nothing else. */
export function isGatewayUrl(u: string): boolean {
  try {
    const x = new URL(u);
    const m = x.pathname.match(/^\/ipfs\/([^/]+)$/);
    return x.protocol === "https:" && x.host === pinataGateway() && !x.search && !x.hash && !!m && CID.test(m[1]!);
  } catch { return false; }
}
