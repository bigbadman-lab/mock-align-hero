// Template → website interface. Only finished interfaces are listed; everything else stays MCP-only.
import type { PublicProfile } from "@/lib/product-profile";
import {
  holderIntelligenceStatusQuery, onchainReportStatusQuery, smartMoneyTrackerStatusQuery, tokenRiskAnalystStatusQuery,
  walletInspectorStatusQuery, whaleWatchStatusQuery,
} from "@/lib/tools/status";
import { WalletInspectorResultView } from "@/components/mcpx/results/wallet-inspector";
import { WhaleWatchResultView } from "@/components/mcpx/results/whale-watch";
import { HolderIntelligenceResultView } from "@/components/mcpx/results/holder-intelligence";
import { TokenRiskResultView } from "@/components/mcpx/results/token-risk-analyst";
import { SmartMoneyResultView } from "@/components/mcpx/results/smart-money-tracker";
import { OnchainReportView } from "@/components/mcpx/results/onchain-report-builder";
import { TokenScannerApp } from "./TokenScannerApp";
import { ToolApp, type ToolAppConfig } from "./ToolApp";
import { AiProductApp } from "@/components/mcpx/ai-tools/AiToolApp";
import { isAiTemplate } from "@/lib/ai-tools/defs";

/* eslint-disable @typescript-eslint/no-explicit-any */
const CONFIGS: Record<string, ToolAppConfig> = {
  "wallet-inspector": { title: "Wallet Inspector", tagline: "See any Solana wallet's SOL balance and token holdings using live onchain data.", form: "address", status: walletInspectorStatusQuery as any, render: (r) => <WalletInspectorResultView r={r as any} /> },
  "whale-watch": { title: "Whale Watch", tagline: "Check an address's recent large SOL transfers using live onchain data.", form: "address", status: whaleWatchStatusQuery as any, render: (r) => <WhaleWatchResultView r={r as any} /> },
  "holder-intelligence": { title: "Holder Intelligence", tagline: "See a token's largest holders and supply concentration using live onchain data.", form: "mint", status: holderIntelligenceStatusQuery as any, render: (r) => <HolderIntelligenceResultView r={r as any} /> },
  "token-risk-analyst": { title: "Token Risk Analyst", tagline: "Review a token's control and concentration indicators using live onchain data.", form: "mint", status: tokenRiskAnalystStatusQuery as any, render: (r) => <TokenRiskResultView r={r as any} /> },
  "smart-money-tracker": { title: "Smart Money Tracker", tagline: "See recent SOL activity for up to 3 wallets using live onchain data.", form: "wallets", status: smartMoneyTrackerStatusQuery as any, render: (r) => <SmartMoneyResultView r={r as any} /> },
  "onchain-report-builder": { title: "Onchain Report Builder", tagline: "Build a point-in-time report for a wallet or token using live onchain data.", form: "report", status: onchainReportStatusQuery as any, render: (r) => <OnchainReportView r={r as any} /> },
};

export const hasWebInterface = (templateId: string) => templateId === "token-scanner" || isAiTemplate(templateId) || Object.hasOwn(CONFIGS, templateId);

export function ProductToolInterface({ p }: { p: PublicProfile }) {
  if (p.availability !== "active" || !p.tool) return null;
  if (p.templateId === "token-scanner") return <TokenScannerApp slug={p.slug} defaultMint={p.childMint} ticker={p.ticker} />;
  if (isAiTemplate(p.templateId)) return <AiProductApp templateId={p.templateId} slug={p.slug} />;
  const cfg = CONFIGS[p.templateId];
  return cfg ? <ToolApp slug={p.slug} cfg={cfg} defaultMint={p.childMint} ticker={p.ticker} fixedSettings={p.tool.fixedSettings} /> : null;
}
