import { createFileRoute } from "@tanstack/react-router";
import { RouteError, StatusMessage } from "@/components/mcpx/primitives";
import { MintToolShell, NOT_MINT, PROGRAM_NAME } from "@/components/mcpx/MintToolShell";
import { explorerAccountUrl } from "@/lib/wallet/state";
import { tokenRiskAnalystStatusQuery } from "@/lib/tools/status";
import { STATE_MEANING, TRA_CLIENT_TIMEOUT_MS, TRA_ENDPOINT, type CheckState, type TokenRiskResult } from "@/lib/tools/token-risk-analyst";
import { cn } from "@/lib/utils";
import { TokenRiskResultView } from "@/components/mcpx/results/token-risk-analyst";

export const Route = createFileRoute("/tools/token-risk-analyst")({
  head: () => ({
    meta: [
      { title: "Token Risk Analyst — MCPX" },
      { name: "description", content: "Evidence checklist of a Solana token's mint and freeze authority, Token-2022 extensions and concentration. No score and no safety verdict." },
      { property: "og:title", content: "Token Risk Analyst — MCPX" },
      { property: "og:description", content: "Observable control and concentration indicators for one Solana mint — observed, not observed or unknown." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: () => (
    <MintToolShell<TokenRiskResult>
      id="tra" name="Token Risk Analyst" label="Template tool · Intelligence" buttonText="Check Token"
      intro="A checklist of what can be verified onchain about who controls a token and how concentrated it is — with the evidence for each line."
      note={<p>This is not a safety rating. It never says a token is safe, a scam or a rug, and there is no score. "Unknown" means it couldn't be checked — not that it's absent.</p>}
      endpoint={TRA_ENDPOINT} timeoutMs={TRA_CLIENT_TIMEOUT_MS} statusQuery={tokenRiskAnalystStatusQuery} render={(r) => <TokenRiskResultView r={r} />}
    />
  ),
  errorComponent: RouteError,
});
