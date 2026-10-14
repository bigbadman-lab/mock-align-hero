import { createFileRoute, Link, notFound } from "@tanstack/react-router";
import { PageContainer, RouteError } from "@/components/mcpx/primitives";
import { CapabilityRow, LaunchLink, TemplateAction } from "@/components/mcpx/TemplateAvailability";
import { LIBRARY, TEMPLATES } from "@/lib/templates";

export const Route = createFileRoute("/templates/$templateId")({
  loader: ({ params }) => {
    const t = LIBRARY.find((x) => x.id === params.templateId);
    if (!t || t.hidden) throw notFound();
    return { id: t.id };
  },
  head: ({ loaderData }) => {
    const t = LIBRARY.find((x) => x.id === loaderData?.id);
    const title = t ? `${t.name} — MCPX template` : "Template not found — MCPX";
    const desc = t ? `${t.tagline} ${t.benefit}` : "This MCPX template does not exist.";
    return { meta: [
      { title }, { name: "description", content: desc },
      { property: "og:title", content: title }, { property: "og:description", content: desc },
      { property: "og:type", content: "website" }, { name: "twitter:card", content: "summary_large_image" },
      ...(t ? [] : [{ name: "robots", content: "noindex" }]),
    ] };
  },
  component: TemplatePage,
  errorComponent: RouteError,
  notFoundComponent: () => (
    <PageContainer className="py-24">
      <h1 className="text-2xl font-semibold text-foreground">Template not found</h1>
      <Link to="/mcp" className="mt-4 inline-block text-sm text-primary underline underline-offset-4">Back to the tool library</Link>
    </PageContainer>
  ),
});

function TemplatePage() {
  const { id } = Route.useLoaderData();
  const t = LIBRARY.find((x) => x.id === id)!;
  const details = TEMPLATES.find((x) => x.id === id)?.details ?? [];
  return (
    <PageContainer className="py-12">
      <Link to="/mcp" className="font-mono text-xs text-muted-foreground hover:text-foreground">← Tool library</Link>
      <div className="mt-6 grid gap-10 lg:grid-cols-[1.1fr_1fr] lg:items-start">
        <div className="overflow-hidden rounded-lg border border-border bg-background">
          <img src={t.image} alt={`${t.name} illustration`} width={1024} height={640} className="h-auto w-full" />
        </div>
        <div>
          <div className="flex flex-wrap gap-2">
            <span className="rounded border border-border px-2 py-0.5 font-mono text-[11px] text-muted-foreground">{t.category}</span>
            {t.planned && <span className="rounded border border-border px-2 py-0.5 font-mono text-[11px] text-subtle">Planned</span>}
          </div>
          <h1 className="mt-4 text-3xl font-semibold text-foreground md:text-4xl">{t.name}</h1>
          <p className="mt-2 text-lg font-medium text-primary">{t.tagline}</p>
          <p className="mt-4 leading-relaxed text-muted-foreground">{t.benefit}</p>
          {details.length > 0 && (
            <ul className="mt-6 space-y-2 text-sm text-muted-foreground">
              {details.map((d) => <li key={d} className="flex gap-2"><span aria-hidden className="text-subtle">—</span>{d.replace(/^Planned: /, "")}</li>)}
            </ul>
          )}
          <section aria-label="Availability" className="mt-8 rounded-lg border border-border bg-card p-5">
            <h2 className="label-mono text-xs text-subtle">Available today</h2>
            <div className="mt-4"><CapabilityRow t={t} /></div>
            <div className="mt-5 flex flex-wrap items-center justify-between gap-3 border-t border-border pt-4"><TemplateAction t={t} /><LaunchLink t={t} /></div>
            {t.id === "canvas" && <p className="mt-3 text-xs text-subtle">Canvas builder, draft saving and dry runs: available to signed-in creators. Public Canvas MCP product: only after a verified child-token launch. Token launching: not available yet.</p>}
            {t.tokenLaunch && t.id !== "canvas" && <p className="mt-3 text-xs text-subtle">Launching opens a draft. Token creation is not available yet — nothing is created or signed.</p>}
          </section>
          <p className="mt-4 font-mono text-xs text-subtle">Template id: {t.id}</p>
        </div>
      </div>
    </PageContainer>
  );
}
