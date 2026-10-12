import { Link, useRouter, type ErrorComponentProps } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { AVAILABILITY_NOTE, type TemplateDefinition } from "@/lib/templates";

export function PageContainer({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn("mx-auto w-full max-w-6xl px-5 sm:px-8", className)}>{children}</div>;
}

export function SectionLabel({ children }: { children: ReactNode }) {
  return (
    <p className="label-mono flex items-center gap-2 text-primary">
      <span aria-hidden className="inline-block h-px w-6 bg-primary" />
      {children}
    </p>
  );
}

export function SectionHeading({
  label, title, intro, as: H = "h2",
}: { label?: string; title: ReactNode; intro?: ReactNode; as?: "h1" | "h2" }) {
  return (
    <div className="max-w-2xl space-y-3">
      {label && <SectionLabel>{label}</SectionLabel>}
      <H className={cn("font-semibold tracking-tight text-foreground", H === "h1" ? "text-4xl sm:text-5xl" : "text-2xl sm:text-3xl")}>
        {title}
      </H>
      {intro && <p className="text-base leading-relaxed text-muted-foreground">{intro}</p>}
    </div>
  );
}

export function PageHeader(props: { label: string; title: ReactNode; intro?: ReactNode }) {
  return (
    <header className="border-b border-border bg-grid">
      <PageContainer className="py-14 sm:py-20 animate-rise">
        <SectionHeading as="h1" {...props} />
      </PageContainer>
    </header>
  );
}

export function StatusMessage({
  children, title, tone = "info",
}: { children?: ReactNode; title: string; tone?: "info" | "warning" }) {
  return (
    <div role="status" className="flex gap-3 rounded-lg border border-border-strong bg-surface-2 p-4">
      <span aria-hidden className={cn("mt-1.5 h-2 w-2 shrink-0 rounded-full", tone === "warning" ? "bg-warning" : "bg-subtle")} />
      <div className="space-y-1">
        <p className="text-sm font-medium text-foreground">{title}</p>
        {children && <div className="text-sm leading-relaxed text-muted-foreground">{children}</div>}
      </div>
    </div>
  );
}

export function InfoCard({ label, title, children, className }: { label?: string; title: string; children: ReactNode; className?: string }) {
  return (
    <div className={cn("rounded-lg border border-border bg-card p-6", className)}>
      {label && <p className="label-mono mb-3 text-subtle">{label}</p>}
      <h3 className="text-base font-semibold text-foreground">{title}</h3>
      <div className="mt-2 text-sm leading-relaxed text-muted-foreground">{children}</div>
    </div>
  );
}

export function EmptyState({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 px-6 py-16 text-center">
      <span aria-hidden className="grid h-10 w-10 place-items-center rounded-md border border-border-strong font-mono text-subtle">∅</span>
      <p className="text-base font-medium text-foreground">{title}</p>
      {children && <div className="max-w-md text-sm leading-relaxed text-muted-foreground">{children}</div>}
    </div>
  );
}

export function FeatureAvailability({ children = "Not available yet" }: { children?: ReactNode }) {
  return (
    <span className="label-mono inline-flex items-center gap-2 rounded border border-border-strong px-2 py-1 text-muted-foreground">
      <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-subtle" />
      {children}
    </span>
  );
}

export function TemplateCard({ t, action }: { t: TemplateDefinition; action?: ReactNode }) {
  return (
    <article className="group flex h-full flex-col rounded-lg border border-border bg-card p-6 transition-colors hover:border-border-strong">
      <div className="flex items-center justify-between gap-3">
        <span className="label-mono text-primary">{t.engine}</span>
        <span className="font-mono text-xs text-subtle">{t.id}</span>
      </div>
      <h3 className="mt-4 text-lg font-semibold text-foreground">{t.name}</h3>
      <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{t.purpose}</p>
      <ul className="mt-4 mb-6 space-y-2 text-sm text-muted-foreground">
        {t.details.map((d) => (
          <li key={d} className="flex gap-2"><span aria-hidden className="text-subtle">—</span>{d}</li>
        ))}
      </ul>
      <div className="mt-auto flex flex-wrap items-center justify-between gap-3 border-t border-border pt-4">
        {action ?? <span className="font-mono text-xs text-subtle">{AVAILABILITY_NOTE}</span>}
        <Link to="/docs" hash="templates" className="text-sm text-foreground underline decoration-border-strong underline-offset-4 hover:decoration-primary">
          View documentation
        </Link>
      </div>
    </article>
  );
}

const btn = "inline-flex min-h-11 items-center justify-center rounded-md px-5 text-sm font-medium transition-colors";
export const buttonPrimary = cn(btn, "bg-primary text-primary-foreground hover:bg-primary/90");
export const buttonOutline = cn(btn, "border border-border-strong text-foreground hover:bg-secondary");

export function RouteError({ error, reset }: ErrorComponentProps) {
  const router = useRouter();
  console.error(error);
  return (
    <PageContainer className="py-24">
      <StatusMessage tone="warning" title="This section didn't load">
        <p>The rest of the site is unaffected.</p>
        <button
          type="button"
          onClick={() => { router.invalidate(); reset(); }}
          className={cn(buttonOutline, "mt-4")}
        >
          Try again
        </button>
      </StatusMessage>
    </PageContainer>
  );
}
