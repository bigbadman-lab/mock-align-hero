import { createFileRoute } from "@tanstack/react-router";
import { RouteError, StatusMessage } from "@/components/mcpx/primitives";
import { MintToolShell, NOT_MINT, PROGRAM_NAME } from "@/components/mcpx/MintToolShell";
import { explorerAccountUrl, shortAddress } from "@/lib/wallet/state";
import { holderIntelligenceStatusQuery } from "@/lib/tools/status";
import { HI_CLIENT_TIMEOUT_MS, HI_ENDPOINT, type HolderIntelligenceResult, type OwnerKind } from "@/lib/tools/holder-intelligence";
import { HolderIntelligenceResultView } from "@/components/mcpx/results/holder-intelligence";

export const Route = createFileRoute("/tools/holder-intelligence")({
  head: () => ({
    meta: [
      { title: "Holder Intelligence — MCPX" },
      { name: "description", content: "Largest token accounts, their owner addresses and concentration for one Solana mint. Coverage stated plainly; never a full holder count." },
      { property: "og:title", content: "Holder Intelligence — MCPX" },
      { property: "og:description", content: "Observable holder concentration for a Solana token at the queried chain state — largest token accounts only." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: () => (
    <MintToolShell<HolderIntelligenceResult>
      id="hi" name="Holder Intelligence" label="Template tool · Intelligence" buttonText="Inspect Holders"
      intro="A one-time look at a token's largest token accounts, who owns them where that can be read onchain, and how concentrated they are against total supply."
      note={<p>This reads the largest token accounts only (up to 20) — not every holder. A token account is not a person, and an owner address may be a pool, exchange or program. No history, no unique-holder count, no bot or pool labels.</p>}
      endpoint={HI_ENDPOINT} timeoutMs={HI_CLIENT_TIMEOUT_MS} statusQuery={holderIntelligenceStatusQuery} render={(r) => <HolderIntelligenceResultView r={r} />}
    />
  ),
  errorComponent: RouteError,
});
