import { useState } from "react";
import type { PublicTool } from "@/lib/product-profile";
import { TESTED_PROTOCOL } from "@/lib/product-profile";
import { buttonOutline } from "./primitives";

export function CopyButton({ text, label = "Copy" }: { text: string; label?: string }) {
  const [state, setState] = useState<"idle" | "ok" | "fail">("idle");
  return (
    <span className="inline-flex items-center gap-2">
      <button type="button" className={buttonOutline} onClick={() => {
        navigator.clipboard?.writeText(text).then(() => setState("ok"), () => setState("fail")) ?? setState("fail");
      }}>{label}</button>
      <span role="status" aria-live="polite" className="font-mono text-xs text-subtle">
        {state === "ok" ? "Copied" : state === "fail" ? "Copy failed — select and copy manually" : ""}
      </span>
    </span>
  );
}

const Code = ({ children }: { children: string }) => (
  <pre className="overflow-x-auto rounded-md border border-border bg-surface-2 p-3 font-mono text-xs text-foreground"><code>{children}</code></pre>
);

/** Render ONLY for an active product whose endpoint the server reported. Never contains a real key. */
export function McpConnection({ endpoint, tool }: { endpoint: string; tool: PublicTool }) {
  const config = JSON.stringify({ mcpServers: { [tool.name]: { type: "streamable-http", url: endpoint, headers: { Authorization: "Bearer <YOUR_PRODUCT_API_KEY>" } } } }, null, 2);
  return (
    <section aria-labelledby="conn-h" className="space-y-3 rounded-lg border border-border bg-card p-4">
      <h2 id="conn-h" className="text-base font-semibold">MCP connection</h2>
      <div className="space-y-1.5">
        <p className="label-mono text-subtle">Endpoint (Streamable HTTP, POST)</p>
        <p className="break-all font-mono text-sm text-foreground">{endpoint}</p>
        <CopyButton text={endpoint} label="Copy endpoint" />
      </div>
      <div className="space-y-1.5">
        <p className="label-mono text-subtle">Example client configuration</p>
        <Code>{config}</Code>
        <p className="text-sm text-muted-foreground">Replace the placeholder with a product API key from the product's creator. Never paste a real key into public pages, chats or shared repositories.</p>
      </div>
      <div className="space-y-1.5">
        <p className="label-mono text-subtle">Tool</p>
        <p className="text-sm text-foreground"><span className="font-mono">{tool.name}</span> · adapter v{tool.adapterVersion}</p>
        <p className="text-sm text-muted-foreground">{tool.description}</p>
        <ul className="list-disc pl-5 text-sm text-muted-foreground">{tool.fixedSettings.map((s) => <li key={s}>{s}</li>)}</ul>
        <p className="label-mono text-subtle">Input schema</p>
        <Code>{tool.inputSchema}</Code>
      </div>
      <div className="space-y-1.5 text-sm text-muted-foreground">
        <p className="label-mono text-subtle">Compatibility</p>
        <p>Tested with the official MCP client on protocol {TESTED_PROTOCOL}. Protocol 2026-07-28 is not yet tested. There is no one-click connect.</p>
        <p className="label-mono text-subtle">Troubleshooting</p>
        <ul className="list-disc pl-5">
          <li>401 — key missing, wrong, revoked or expired. Ask the creator for a new key.</li>
          <li>403 — your client sent a browser Origin that isn't allowed. Call from a server or desktop client.</li>
          <li>404 — the product is not available (inactive, suspended or unknown).</li>
          <li>429 — shared rate limit reached. Wait a minute.</li>
          <li>503 — the backend or execution service is temporarily unavailable.</li>
        </ul>
      </div>
    </section>
  );
}
