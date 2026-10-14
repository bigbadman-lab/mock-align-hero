import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { StatusMessage, buttonOutline, buttonPrimary } from "@/components/mcpx/primitives";
import { CopyValue } from "@/components/mcpx/McpConnection";
import { tokenScannerStatusQuery } from "@/lib/tools/status";
import { isValidSolanaAddress } from "@/lib/tools/wallet-inspector";
import type { TokenScannerResult } from "@/lib/tools/token-scanner";
import { explorerAccountUrl } from "@/lib/wallet/state";
import { ResultBlock, ResultFrame, Row, RunErrorView, useProductRun } from "./shared";

const PROGRAM_NAME = { "spl-token": "SPL Token (original programme)", "token-2022": "Token-2022" } as const;
const NA = <span className="text-muted-foreground">Not reported</span>;

/** Formats a base-unit integer string with verified decimals, without floating point. */
export function formatSupply(raw: string, decimals: number): string {
  const s = raw.replace(/^0+(?=\d)/, "");
  const pad = s.padStart(decimals + 1, "0");
  const int = pad.slice(0, pad.length - decimals).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const frac = decimals ? pad.slice(pad.length - decimals).replace(/0+$/, "") : "";
  return frac ? `${int}.${frac}` : int;
}

/** Plain-language supply cross-check, strictly from the tool's own supplyCheck. */
export function supplyCheckText(c: TokenScannerResult["supplyCheck"]): { tone: "ok" | "warn" | "na"; text: string } {
  if (c.status === "ok" && c.matches === true) return { tone: "ok", text: `Consistent — a second supply read agreed${c.slot !== null ? ` (slot ${c.slot})` : ""}.` };
  if (c.status === "ok" && c.matches === false) return { tone: "warn", text: `Inconsistent — the second read returned ${c.supplyRaw ?? "a different value"} base units${c.slot !== null ? ` at slot ${c.slot}` : ""}. Supply may have changed between reads.` };
  if (c.status === "not_applicable") return { tone: "na", text: "Not applicable for this address." };
  return { tone: "na", text: "Unavailable — only the account read is shown." };
}

function Authority({ v, kind }: { v: string | null; kind: "mint" | "freeze" }) {
  if (v === null) return <span>None — {kind === "mint" ? "no one can mint more" : "no one can freeze accounts"} (revoked or never set)</span>;
  const url = explorerAccountUrl(v);
  return <span className="inline-flex flex-wrap items-baseline gap-x-2"><CopyValue text={v} hint="Copy" />{url && <a className="text-xs underline" href={url} target="_blank" rel="noreferrer">Solscan</a>}</span>;
}

export function TokenScannerResultView({ r }: { r: TokenScannerResult }) {
  const notMint: Record<Exclude<TokenScannerResult["status"], "mint">, string> = {
    not_found: "No account exists at this address. It may never have existed or may have been closed.",
    not_token_program: "This account exists but isn't owned by SPL Token or Token-2022, so it isn't a token mint (it may be a wallet or a program).",
    not_a_mint: `This is a ${r.program ? PROGRAM_NAME[r.program] : "token programme"} account, but it's a ${r.accountType === "account" ? "token holding account" : (r.accountType ?? "non-mint account")} — not a mint.`,
    unparsed: "The provider couldn't decode this token account, so nothing is shown.",
  };
  const sc = supplyCheckText(r.supplyCheck);
  return (
    <ResultFrame
      title={r.status === "mint" ? "Scan result" : "Not a token mint"}
      raw={r}
      meta={<>Read {r.fetchedAt.slice(0, 19).replace("T", " ")} UTC · slot {r.accountSlot} ({r.commitment}) · Solana mainnet. Onchain facts only — not a safety verdict or trading advice. <span className="font-mono">Execution {r.executionId}</span></>}
    >
      {r.status !== "mint" ? (
        <StatusMessage tone="warning" title="Not a supported token mint">
          <p>{notMint[r.status]}</p>
          {r.owner && <p className="break-all font-mono text-xs">Owning program: {r.owner}</p>}
        </StatusMessage>
      ) : (
        <div className="grid gap-3 lg:grid-cols-2">
          <ResultBlock title="Token overview">
            <dl>
              <Row k="Mint"><CopyValue text={r.mint} hint="Copy" /></Row>
              <Row k="Programme">{r.program ? PROGRAM_NAME[r.program] : NA}</Row>
              <Row k="Valid mint">{r.isInitialized === true ? "Yes — initialised mint" : r.isInitialized === false ? "Not initialised" : NA}</Row>
              <Row k="Decimals"><span className="font-mono">{r.decimals ?? NA}</span></Row>
              <Row k="Supply">
                {r.supplyRaw !== null && r.decimals !== null
                  ? <span className="font-mono">{formatSupply(r.supplyRaw, r.decimals)}<span className="block text-xs text-muted-foreground">{r.supplyRaw} base units</span></span>
                  : NA}
              </Row>
            </dl>
          </ResultBlock>
          <ResultBlock title="Authorities">
            <dl>
              <Row k="Mint authority"><Authority v={r.mintAuthority} kind="mint" /></Row>
              <Row k="Freeze authority"><Authority v={r.freezeAuthority} kind="freeze" /></Row>
            </dl>
            <p className="mt-2 text-xs text-muted-foreground">An absent authority is a permission fact, not proof a token is safe.</p>
          </ResultBlock>
          <ResultBlock title="Token-2022 extensions">
            {r.program !== "token-2022" ? (
              <p className="text-sm text-muted-foreground">This mint uses the original SPL Token programme, which has no extensions.</p>
            ) : r.extensions && r.extensions.length > 0 ? (
              <ul className="space-y-2 text-sm">
                {r.extensions.map((e, i) => (
                  <li key={i}>
                    <span className="font-mono text-foreground">{e.decoded ? e.name : "Extension (details unavailable)"}</span>
                    {e.state && <pre className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap break-all rounded bg-surface-2 p-2 font-mono text-xs text-muted-foreground">{e.state}</pre>}
                  </li>
                ))}
              </ul>
            ) : <p className="text-sm text-muted-foreground">No extensions were reported on this mint.</p>}
            {r.program === "token-2022" && r.extensionsComplete === false && <p className="mt-2 text-xs text-warning">Some extensions couldn't be decoded, so this list may be incomplete.</p>}
          </ResultBlock>
          <ResultBlock title="Supply verification">
            <p className={sc.tone === "warn" ? "text-sm text-warning" : sc.tone === "ok" ? "text-sm text-foreground" : "text-sm text-muted-foreground"}>{sc.text}</p>
          </ResultBlock>
        </div>
      )}
    </ResultFrame>
  );
}

export function TokenScannerApp({ slug, defaultMint, ticker }: { slug: string; defaultMint: string; ticker: string }) {
  const status = useQuery(tokenScannerStatusQuery);
  const run = useProductRun<TokenScannerResult>(slug);
  const [mint, setMint] = useState("");
  const [touched, setTouched] = useState(false);
  const trimmed = mint.trim();
  const valid = isValidSolanaAddress(trimmed);
  const available = status.data?.available === true;
  const submit = (e: React.FormEvent) => {
    e.preventDefault(); setTouched(true);
    if (valid && available && !run.isPending) run.mutate({ mint: trimmed });
  };
  const paste = async () => {
    try { const t = await navigator.clipboard.readText(); setMint(t.trim()); setTouched(true); } catch { /* permission denied: user can paste manually */ }
  };

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-xl font-semibold text-foreground">Token Scanner</h2>
        <p className="text-sm text-muted-foreground">Inspect any Solana token mint using live onchain data.</p>
      </div>

      {status.isPending && <StatusMessage title="Checking the tool is ready…" />}
      {status.isError && <StatusMessage tone="warning" title="Couldn't check the tool"><button className="underline" onClick={() => void status.refetch()}>Check again</button></StatusMessage>}
      {status.data && !available && (
        <StatusMessage tone="warning" title="Token Scanner isn't running right now">
          <p>Scans can't run at the moment. Nothing is simulated — try again later.</p>
        </StatusMessage>
      )}

      <form onSubmit={submit} className="space-y-2" noValidate>
        <label htmlFor="ps-mint" className="label-mono block text-xs text-subtle">Token mint address</label>
        <div className="flex flex-col gap-2 sm:flex-row">
          <input
            id="ps-mint" value={mint} onChange={(e) => setMint(e.target.value)} onBlur={() => setTouched(true)}
            maxLength={60} autoComplete="off" spellCheck={false} aria-invalid={touched && !!trimmed && !valid} aria-describedby="ps-help"
            className="min-w-0 flex-1 rounded-md border border-border-strong bg-surface-2 px-3 py-2 font-mono text-sm text-foreground focus-visible:outline-2 focus-visible:outline-primary"
            placeholder="Paste a Solana token mint address"
          />
          <div className="flex gap-2">
            <button type="button" className={buttonOutline} onClick={() => void paste()}>Paste</button>
            <button type="submit" className={buttonPrimary} disabled={!valid || !available || run.isPending} aria-disabled={!valid || !available || run.isPending}>
              {run.isPending ? "Scanning…" : "Scan Token"}
            </button>
          </div>
        </div>
        <p id="ps-help" className="text-xs text-muted-foreground">
          {touched && trimmed && !valid
            ? <span className="text-warning">That isn't a valid Solana address. Check for missing or extra characters.</span>
            : <>SPL Token or Token-2022 mint, Solana mainnet. <button type="button" className="underline underline-offset-4" onClick={() => { setMint(defaultMint); setTouched(true); }}>Use ${ticker}'s mint</button></>}
        </p>
      </form>

      <div aria-live="polite" aria-busy={run.isPending}>
        {run.isPending && run.variables && (
          <p className="flex items-center gap-2 break-all font-mono text-xs text-muted-foreground">
            <span className="h-2 w-2 shrink-0 animate-pulse rounded-full bg-primary" aria-hidden /> Reading {String(run.variables["mint"])} from Solana…
          </p>
        )}
        {run.isError && !run.isPending && <RunErrorView error={run.error} disabled={run.isPending} onRetry={run.variables ? () => run.mutate(run.variables!) : undefined} />}
        {run.data && !run.isPending && <TokenScannerResultView r={run.data} />}
        {run.isIdle && (
          <p className="rounded-md border border-dashed border-border p-4 text-sm text-muted-foreground">
            Enter a mint address and press Scan Token to see its programme, supply, authorities and extensions.
          </p>
        )}
      </div>
    </div>
  );
}
