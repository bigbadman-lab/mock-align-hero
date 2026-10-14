// Verified MCP products for the signed-in creator. Session state comes from the shared provider;
// this component never signs anything. The server re-checks wallet ownership on every request.
import { useEffect, useState } from "react";
import { ProductKeys } from "./ProductKeys";
import { Link } from "@tanstack/react-router";
import { buttonOutline } from "@/components/mcpx/primitives";
import { useCreatorSessionContext } from "@/lib/creator-auth/session-context";

type Product = { creationId: string; displayName: string; templateId: string };
type St = { k: "loading" } | { k: "ready"; products: Product[] } | { k: "error" };

export function CreatorProducts() {
  const session = useCreatorSessionContext();
  const wallet = session.s === "signed_in" ? session.wallet : null;
  const [st, setSt] = useState<St>({ k: "loading" });
  const ended = () => session.ended("Your session ended. Verify again to continue.");

  useEffect(() => {
    if (!wallet) return;
    let live = true;
    setSt({ k: "loading" });
    fetch("/api/creator/products", { credentials: "same-origin" })
      .then(async (r) => {
        if (!live) return;
        if (r.status === 401) return ended();
        const b = (await r.json().catch(() => null)) as { products?: Product[] } | null;
        setSt(r.ok && b ? { k: "ready", products: b.products ?? [] } : { k: "error" });
      })
      .catch(() => live && setSt({ k: "error" }));
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wallet]);

  if (!wallet) return null;
  return (
    <div role="status" aria-live="polite" className="space-y-3 text-sm text-muted-foreground">
      {st.k === "loading" && <div className="h-16 animate-pulse rounded-md bg-surface-2" aria-label="Loading your products" />}
      {st.k === "error" && <p>Couldn't load your products. Reload to try again.</p>}
      {st.k === "ready" && st.products.length === 0 && (
        <div className="space-y-3">
          <p>No verified MCP products linked to this wallet yet. Products appear here after a token launch is verified on-chain.</p>
          <Link to="/launch" className={buttonOutline}>Launch a token</Link>
        </div>
      )}
      {st.k === "ready" && st.products.length > 0 && (
        <ul className="space-y-3">
          {st.products.map((p) => <ProductKeys key={`${wallet}:${p.creationId}`} creationId={p.creationId} displayName={p.displayName} onSessionEnded={ended} />)}
        </ul>
      )}
    </div>
  );
}
