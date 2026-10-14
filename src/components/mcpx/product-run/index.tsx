// Template → website interface. Only finished interfaces are listed; everything else stays MCP-only.
import type { PublicProfile } from "@/lib/product-profile";
import { TokenScannerApp } from "./TokenScannerApp";

export const WEB_INTERFACES = ["token-scanner"] as const;
export const hasWebInterface = (templateId: string) => (WEB_INTERFACES as readonly string[]).includes(templateId);

export function ProductToolInterface({ p }: { p: PublicProfile }) {
  if (p.availability !== "active" || !p.tool) return null;
  switch (p.templateId) {
    case "token-scanner": return <TokenScannerApp slug={p.slug} defaultMint={p.childMint} ticker={p.ticker} />;
    default: return null;
  }
}
