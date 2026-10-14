import { useEffect, useState, type ReactNode } from "react";
import { Check, Copy } from "lucide-react";
import { countdown, STATUS_LABEL, short, type Overview } from "@/lib/treasury/core";
import { cn } from "@/lib/utils";

export const explorer = (kind: "token" | "tx" | "account", v: string) => `https://solscan.io/${kind}/${v}`;

export function CopyText({ value, label, n = 4 }: { value: string; label: string; n?: number }) {
  const [ok, setOk] = useState(false);
  return (
    <button type="button" onClick={() => { void navigator.clipboard?.writeText(value).then(() => { setOk(true); setTimeout(() => setOk(false), 1500); }); }}
      className="inline-flex items-center gap-1.5 font-mono text-xs text-foreground hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded"
      aria-label={`Copy ${label}`} title={value}>
      <span className="sm:hidden">{short(value, n)}</span><span className="hidden sm:inline">{short(value, n + 4)}</span>
      {ok ? <Check className="h-3 w-3 text-primary" aria-hidden /> : <Copy className="h-3 w-3 text-subtle" aria-hidden />}
      <span className="sr-only" aria-live="polite">{ok ? "Copied" : ""}</span>
    </button>
  );
}

export function Stat({ label, value, note, accent }: { label: string; value: ReactNode; note?: ReactNode; accent?: boolean }) {
  return (
    <div className="rounded-md border border-border bg-background/40 p-4">
      <p className="label-mono text-[10px] text-subtle">{label}</p>
      <p className={cn("mt-2 font-mono text-lg", accent ? "text-primary" : "text-foreground")}>{value}</p>
      {note && <p className="mt-1 text-[11px] text-subtle">{note}</p>}
    </div>
  );
}

/** Countdown to the next UTC five-minute boundary, offset by server time so client clock skew doesn't matter. */
export function WindowClock({ o, large }: { o: Overview; large?: boolean }) {
  const offset = Date.parse(o.serverTime) - Date.now();
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 1000);
    const vis = () => setNow(Date.now());
    document.addEventListener("visibilitychange", vis);
    return () => { clearInterval(t); document.removeEventListener("visibilitychange", vis); };
  }, []);
  const c = now === null ? null : countdown(offset, now);
  const status = o.windows.status;
  return (
    <div>
      <p className="label-mono text-[10px] text-subtle">Next 5-minute window (UTC)</p>
      <p className={cn("mt-1 font-mono tabular-nums text-foreground", large ? "text-5xl" : "text-3xl")} aria-label="Time to next processing boundary">
        {c ? `${c.mm}:${c.ss}` : "--:--"}
      </p>
      <p className="mt-2 inline-flex items-center gap-2 font-mono text-xs">
        <span className={cn("h-1.5 w-1.5 rounded-full", status === "WINDOW_UPCOMING" ? "bg-primary" : status === "DELAYED" ? "bg-warning" : "bg-subtle")} aria-hidden />
        <span className={status === "DELAYED" ? "text-warning" : "text-muted-foreground"}>{STATUS_LABEL[status]}</span>
      </p>
    </div>
  );
}

export function ModeBadge({ mode }: { mode: Overview["mode"] }) {
  if (mode === "PRODUCTION") return null;
  return <span className={cn("rounded border px-2 py-0.5 font-mono text-[11px]", mode === "REHEARSAL" ? "border-warning text-warning" : "border-border text-subtle")}>{mode === "REHEARSAL" ? "REHEARSAL — not $MCP" : "Prelaunch"}</span>;
}

export const DISCLAIMER = "Holder rewards depend on eligible fees actually collected and finalized. No APY or guaranteed payout.";

export function Updated({ at, stale }: { at?: string; stale?: boolean }) {
  if (!at) return null;
  return <p className={cn("font-mono text-[11px]", stale ? "text-warning" : "text-subtle")}>{stale ? "Showing last known values — refresh failed. " : ""}Updated {new Date(at).toUTCString().slice(17, 25)} UTC</p>;
}
