import { createFileRoute, Link, notFound } from "@tanstack/react-router";
import { PageContainer, PageHeader, RouteError } from "@/components/mcpx/primitives";
import { AiLibraryApp } from "@/components/mcpx/ai-tools/AiToolApp";
import { LaunchLink } from "@/components/mcpx/TemplateAvailability";
import { LIBRARY } from "@/lib/templates";
import { isAiTemplate } from "@/lib/ai-tools/defs";

export const Route = createFileRoute("/tools/ai/$tool")({
  loader: ({ params }) => {
    if (!isAiTemplate(params.tool)) throw notFound();
    return { id: params.tool };
  },
  head: ({ loaderData }) => {
    const t = LIBRARY.find((x) => x.id === loaderData?.id);
    const title = t ? `${t.name} — MCPX` : "Tool not found — MCPX";
    const desc = t ? `${t.tagline} ${t.benefit}` : "This MCPX tool does not exist.";
    return { meta: [
      { title }, { name: "description", content: desc },
      { property: "og:title", content: title }, { property: "og:description", content: desc },
      { property: "og:type", content: "website" }, { name: "twitter:card", content: "summary" },
    ] };
  },
  component: AiToolPage,
  errorComponent: RouteError,
  notFoundComponent: () => (
    <PageContainer className="py-24">
      <h1 className="text-2xl font-semibold text-foreground">Tool not found</h1>
      <Link to="/mcp" className="mt-4 inline-block text-sm text-primary underline underline-offset-4">Back to the tool library</Link>
    </PageContainer>
  ),
});

function AiToolPage() {
  const { id } = Route.useLoaderData();
  const t = LIBRARY.find((x) => x.id === id)!;
  return (
    <>
      <PageHeader className="py-6 sm:py-8" label="Template tool · Entertainment & Experimental AI" title={t.name} intro={`${t.tagline} ${t.benefit}`} />
      <PageContainer className="space-y-4 py-6">
        <div className="max-w-2xl"><AiLibraryApp templateId={t.id} /></div>
        <div className="flex flex-wrap gap-4 text-sm">
          <Link to="/templates/$templateId" params={{ templateId: t.id }} className="text-muted-foreground underline underline-offset-4">Template details</Link>
          <LaunchLink t={t} />
        </div>
      </PageContainer>
    </>
  );
}
