// Website "Use Tool" app for launched products other than Token Scanner. Each template supplies its form
// kind and its existing Tool Library result renderer; requests go through the shared product runner.
import { useState, type ReactNode } from "react";
import { useQuery, type UseQueryOptions } from "@tanstack/react-query";
import { StatusMessage, buttonOutline, buttonPrimary } from "@/components/mcpx/primitives";
import { CopyButton } from "@/components/mcpx/McpConnection";
import { isValidSolanaAddress } from "@/lib/tools/wallet-inspector";
import { SMT_MAX_WALLETS } from "@/lib/tools/smart-money-tracker";
import type { ToolStatus } from "@/lib/tools/status";
import { RunErrorView, useProductRun } from "./shared";

export type FormKind = "address" | "mint" | "wallets" | "report";
export interface ToolAppConfig {
  title: string;
  tagline: string;
  form: FormKind;
  status: UseQueryOptions<ToolStatus, Error, ToolStatus, readonly unknown[]>;
  render(r: unknown): ReactNode;
}

const inputCls = "min-w-0 flex-1 rounded-md border border-border-strong bg-surface-2 px-3 py-2 font-mono text-sm text-foreground focus-visible:outline-2 focus-visible:outline-primary";

function AddressInput({ id, label, value, onChange, placeholder, touched }: { id: string; label: string; value: string; onChange(v: string): void; placeholder: string; touched: boolean }) {
  const bad = touched && !!value.trim() && !isValidSolanaAddress(value.trim());
  const paste = async () => { try { onChange((await navigator.clipboard.readText()).trim()); } catch { /* user can paste manually */ } };
  return (
    <div className="space-y-1">
      <label htmlFor={id} className="label-mono block text-xs text-subtle">{label}</label>
      <div className="flex gap-2">
        <input id={id} value={value} onChange={(e) => onChange(e.target.value)} maxLength={60} autoComplete="off" spellCheck={false} aria-invalid={bad} placeholder={placeholder} className={inputCls} />
        <button type="button" className={buttonOutline} onClick={() => void paste()}>Paste</button>
      </div>
      {bad && <p className="text-xs text-warning">That isn't a valid Solana address. Check for missing or extra characters.</p>}
    </div>
  );
}

export function ToolApp({ slug, cfg, defaultMint, ticker, fixedSettings }: { slug: string; cfg: ToolAppConfig; defaultMint: string; ticker: string; fixedSettings: string[] }) {
  const status = useQuery(cfg.status);
  const run = useProductRun<unknown>(slug);
  const [a, setA] = useState("");
  const [wallets, setWallets] = useState<string[]>([""]);
  const [target, setTarget] = useState<"wallet" | "token">("wallet");
  const [touched, setTouched] = useState(false);
  const available = status.data?.available === true;

  const ws = wallets.map((w) => w.trim()).filter(Boolean);
  let input: Record<string, unknown> | null = null;
  if (cfg.form === "address" && isValidSolanaAddress(a.trim())) input = { address: a.trim() };
  if (cfg.form === "mint" && isValidSolanaAddress(a.trim())) input = { mint: a.trim() };
  if (cfg.form === "report" && isValidSolanaAddress(a.trim())) input = { targetType: target, target: a.trim() };
  if (cfg.form === "wallets" && ws.length > 0 && ws.every(isValidSolanaAddress) && new Set(ws).size === ws.length) input = { wallets: ws };
  const dupes = cfg.form === "wallets" && new Set(ws).size !== ws.length;

  const submit = (e: React.FormEvent) => {
    e.preventDefault(); setTouched(true);
    if (input && available && !run.isPending) run.mutate(input);
  };
  const busy = run.isPending;
  const showMintShortcut = cfg.form === "mint" || (cfg.form === "report" && target === "token");

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-xl font-semibold text-foreground">{cfg.title}</h2>
        <p className="text-sm text-muted-foreground">{cfg.tagline}</p>
      </div>

      {status.isPending && <StatusMessage title="Checking the tool is ready…" />}
      {status.isError && <StatusMessage tone="warning" title="Couldn't check the tool"><button className="underline" onClick={() => void status.refetch()}>Check again</button></StatusMessage>}
      {status.data && !available && (
        <StatusMessage tone="warning" title={`${cfg.title} isn't running right now`}>
          <p>Runs can't happen at the moment. Nothing is simulated — try again later.</p>
        </StatusMessage>
      )}

      <form onSubmit={submit} className="space-y-3" noValidate>
        {cfg.form === "report" && (
          <fieldset className="flex flex-wrap gap-4 text-sm">
            <legend className="label-mono mb-1 text-xs text-subtle">Report on</legend>
            {(["wallet", "token"] as const).map((t) => (
              <label key={t} className="inline-flex items-center gap-2">
                <input type="radio" name="target-type" checked={target === t} onChange={() => setTarget(t)} />
                {t === "wallet" ? "A wallet" : "A token mint"}
              </label>
            ))}
          </fieldset>
        )}
        {cfg.form === "wallets" ? (
          <div className="space-y-2">
            {wallets.map((w, i) => (
              <AddressInput key={i} id={`pw-${i}`} label={`Wallet ${i + 1}`} value={w} touched={touched} placeholder="Solana wallet address"
                onChange={(v) => setWallets((cur) => cur.map((x, j) => (j === i ? v : x)))} />
            ))}
            <div className="flex gap-2">
              {wallets.length < SMT_MAX_WALLETS && <button type="button" className="text-sm underline underline-offset-4" onClick={() => setWallets((c) => [...c, ""])}>Add wallet</button>}
              {wallets.length > 1 && <button type="button" className="text-sm underline underline-offset-4" onClick={() => setWallets((c) => c.slice(0, -1))}>Remove last</button>}
            </div>
            {dupes && <p className="text-xs text-warning">Each wallet can only be entered once.</p>}
          </div>
        ) : (
          <AddressInput
            id="pt-addr" touched={touched} value={a} onChange={setA}
            label={cfg.form === "mint" || (cfg.form === "report" && target === "token") ? "Token mint address" : "Wallet address"}
            placeholder={cfg.form === "mint" || (cfg.form === "report" && target === "token") ? "Paste a Solana token mint address" : "Paste a Solana wallet address"}
          />
        )}
        <div className="flex flex-wrap items-center gap-3">
          <button type="submit" className={buttonPrimary} disabled={!input || !available || busy} aria-disabled={!input || !available || busy}>
            {busy ? "Running…" : "Run"}
          </button>
          {showMintShortcut && <button type="button" className="text-xs underline underline-offset-4" onClick={() => setA(defaultMint)}>Use ${ticker}'s mint</button>}
        </div>
        {fixedSettings.length > 0 && fixedSettings[0] !== "No product-level settings: every caller gets the same read." && (
          <ul className="text-xs text-muted-foreground">{fixedSettings.map((s) => <li key={s}>{s}</li>)}</ul>
        )}
        <p className="text-xs text-muted-foreground">Solana mainnet, read-only. No wallet connection needed.</p>
      </form>

      <div aria-live="polite" aria-busy={busy}>
        {busy && <p className="flex items-center gap-2 text-xs text-muted-foreground"><span className="h-2 w-2 shrink-0 animate-pulse rounded-full bg-primary" aria-hidden /> Reading from Solana…</p>}
        {run.isError && !busy && <RunErrorView error={run.error} disabled={busy} onRetry={run.variables ? () => run.mutate(run.variables!) : undefined} />}
        {run.data !== undefined && !busy && (
          <div className="space-y-2">
            {cfg.render(run.data)}
            <div className="flex flex-wrap items-center gap-2">
              <CopyButton text={JSON.stringify(run.data, null, 2)} label="Copy results" />
            </div>
            <details className="rounded-md border border-border bg-surface-2">
              <summary className="cursor-pointer px-3 py-2 font-mono text-xs text-subtle">Raw JSON</summary>
              <pre className="max-h-96 overflow-auto border-t border-border p-3 font-mono text-xs text-foreground">{JSON.stringify(run.data, null, 2)}</pre>
            </details>
          </div>
        )}
        {run.isIdle && <p className="rounded-md border border-dashed border-border p-4 text-sm text-muted-foreground">Fill in the address above and press Run to see live onchain results.</p>}
      </div>
    </div>
  );
}
