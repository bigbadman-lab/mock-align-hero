import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "@tanstack/react-router";
import { LIBRARY, type LibraryTemplate } from "@/lib/templates";
import { cn } from "@/lib/utils";

/**
 * Horizontal showcase rail for the tool library: all eleven catalogue entries,
 * three-ish visible at a time. Every card links to a real page — a tool's own
 * page, or the launch form for Canvas. Nothing here is a decorative placeholder.
 */
export function ToolRail() {
  const rail = useRef<HTMLUListElement>(null);
  const [edges, setEdges] = useState({ start: true, end: false });

  const measure = useCallback(() => {
    const el = rail.current;
    if (!el) return;
    const max = el.scrollWidth - el.clientWidth;
    setEdges({ start: el.scrollLeft <= 4, end: el.scrollLeft >= max - 4 });
  }, []);

  useEffect(() => {
    measure();
    const onResize = () => measure();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [measure]);

  const nudge = (dir: -1 | 1) => {
    const el = rail.current;
    if (!el) return;
    const card = el.querySelector("li");
    const step = card ? card.getBoundingClientRect().width + 16 : el.clientWidth * 0.8;
    el.scrollBy({ left: dir * step, behavior: "smooth" });
  };

  return (
    <div className="relative">
      <ul
        ref={rail}
        onScroll={measure}
        tabIndex={0}
        aria-label="Tool library. Scroll sideways to see every tool."
        className="mt-8 flex snap-x snap-mandatory gap-4 overflow-x-auto scroll-smooth pb-1 outline-none [scrollbar-width:none] focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-scrollbar]:hidden"
      >
        {LIBRARY.filter((t) => !t.hidden).map((t) => (
          <li key={t.id} className="w-[264px] shrink-0 snap-start sm:w-[312px]">
            <RailCard t={t} />
          </li>
        ))}
      </ul>

      <div
        aria-hidden
        className={cn("pointer-events-none absolute inset-y-0 left-0 w-10 transition-opacity duration-200", edges.start && "opacity-0")}
        style={{ background: "linear-gradient(to right, var(--background), transparent)" }}
      />
      <div
        aria-hidden
        className={cn("pointer-events-none absolute inset-y-0 right-0 w-10 transition-opacity duration-200", edges.end && "opacity-0")}
        style={{ background: "linear-gradient(to left, var(--background), transparent)" }}
      />

      <div className="mt-4 flex items-center justify-between gap-4">
        <p className="font-mono text-xs text-subtle">{LIBRARY.filter((t) => !t.hidden).length} tools · scroll for more</p>
        <div className="flex gap-2">
          <RailButton label="Previous tools" disabled={edges.start} onClick={() => nudge(-1)}>←</RailButton>
          <RailButton label="Next tools" disabled={edges.end} onClick={() => nudge(1)}>→</RailButton>
        </div>
      </div>
    </div>
  );
}

function RailButton({ label, disabled, onClick, children }: { label: string; disabled: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className="grid h-10 w-10 place-items-center rounded-md border border-border-strong text-foreground transition-colors hover:border-primary hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:border-border disabled:text-subtle"
    >
      <span aria-hidden>{children}</span>
    </button>
  );
}

function RailCard({ t }: { t: LibraryTemplate }) {
  const cls = "group flex h-full flex-col overflow-hidden rounded-lg border border-border bg-card transition-colors hover:border-border-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";
  const inner = (
    <>
      <div className="relative aspect-[16/10] overflow-hidden border-b border-border bg-background">
        <img src={t.image} alt="" width={1024} height={640} loading="lazy" decoding="async" className="h-full w-full object-cover opacity-90 transition-transform duration-500 group-hover:scale-[1.03]" />
        <span className="absolute left-3 top-3 rounded border border-border bg-background/80 px-2 py-0.5 font-mono text-[11px] text-muted-foreground backdrop-blur">{t.category}</span>
        {t.mcpAdapter && <span className="absolute right-3 top-3 rounded border border-primary/40 bg-background/80 px-2 py-0.5 font-mono text-[11px] text-primary backdrop-blur">MCP</span>}
      </div>
      <div className="flex flex-1 flex-col p-5">
        <h3 className="text-base font-semibold text-foreground">{t.name}</h3>
        <p className="mt-1 text-sm leading-relaxed text-muted-foreground">{t.tagline}</p>
        <span className="mt-auto pt-4 font-mono text-xs text-subtle transition-colors group-hover:text-primary">
          {t.id === "canvas" ? "Configure pipeline" : "Open tool"} <span aria-hidden>→</span>
        </span>
      </div>
    </>
  );
  if (t.id === "canvas") {
    return <Link to="/launch" search={{ template: "canvas" }} className={cls}>{inner}</Link>;
  }
  if (t.route) {
    return <Link to={t.route as "/tools/wallet-inspector"} search={{}} className={cls}>{inner}</Link>;
  }
  return <div className={cls}>{inner}</div>;
}
