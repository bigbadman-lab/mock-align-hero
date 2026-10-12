import { createFileRoute, ClientOnly } from "@tanstack/react-router";
import { PageContainer, PageHeader, RouteError } from "@/components/mcpx/primitives";
import { VerifiedRegistry, RegistryLoading } from "@/components/mcpx/VerifiedRegistry";

export const Route = createFileRoute("/paired")({
  head: () => ({
    meta: [
      { title: "Paired Market — MCPX" },
      { name: "description", content: "Directory of verified MCPX child tokens paired to $MCP. No listings yet." },
      { property: "og:title", content: "Paired Market — MCPX" },
      { property: "og:description", content: "Verified child-token listings will appear here after genuine launches." },
    ],
  }),
  component: Paired,
  errorComponent: RouteError,
});

function Paired() {
  return (
    <>
      <PageHeader label="Paired market" title="Paired tokens" intro="Child tokens paired to $MCP, each powering one tool." />
      <PageContainer className="py-16">
        <ClientOnly fallback={<RegistryLoading />}>
          <VerifiedRegistry />
        </ClientOnly>
      </PageContainer>
    </>
  );
}
