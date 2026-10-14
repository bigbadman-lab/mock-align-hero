import img_wallet_inspector from "@/assets/templates/wallet-inspector.jpg";
import img_whale_watch from "@/assets/templates/whale-watch.jpg";
import img_token_scanner from "@/assets/templates/token-scanner.jpg";
import img_supply_monitor from "@/assets/templates/supply-monitor.jpg";
import img_transaction_verifier from "@/assets/templates/transaction-verifier.jpg";
import img_account_checker from "@/assets/templates/account-checker.jpg";
import img_holder_intelligence from "@/assets/templates/holder-intelligence.jpg";
import img_token_risk_analyst from "@/assets/templates/token-risk-analyst.jpg";
import img_smart_money_tracker from "@/assets/templates/smart-money-tracker.jpg";
import img_canvas from "@/assets/templates/canvas.jpg";
import img_onchain_report_builder from "@/assets/templates/onchain-report-builder.jpg";
// Static product-definition catalogue. These are planned templates,
// launchable via the launch form. Live availability is never stored here.
export type Engine = "WALLET" | "TOKEN" | "VERIFY" | "COMPOSE";

export interface TemplateDefinition {
  id: string;
  name: string;
  engine: Engine;
  purpose: string;
  details: string[];
}

export const ENGINES: { id: Engine; blurb: string }[] = [
  { id: "WALLET", blurb: "Read wallet balances and recent activity on demand." },
  { id: "TOKEN", blurb: "Read mint configuration and supply distribution." },
  { id: "VERIFY", blurb: "Check transactions and account facts directly." },
];

export const TEMPLATES: TemplateDefinition[] = [
  {
    id: "wallet-inspector",
    name: "Wallet Inspector",
    engine: "WALLET",
    purpose: "Inspect a wallet's SOL and SPL token balances and its recent transactions.",
    details: [
      "Planned: 10 recent transactions by default, up to 25.",
      "USD values optional, always labelled with their source.",
    ],
  },
  {
    id: "whale-watch",
    name: "Whale Watch",
    engine: "WALLET",
    purpose: "Look up recent activity for a wallet when you ask for it.",
    details: [
      "Planned: choose 10, 25 or 50 recent transactions.",
      "Optional filter for transfers or swaps.",
      "On-demand only, not continuous alerting or monitoring.",
    ],
  },
  {
    id: "token-scanner",
    name: "Token Scanner",
    engine: "TOKEN",
    purpose: "Inspect a token's mint authority, freeze authority, supply and decimals.",
    details: [
      "Market data shown only where a genuine source supports it.",
      "Authority fields reported exactly as stored onchain.",
    ],
  },
  {
    id: "supply-monitor",
    name: "Supply Monitor",
    engine: "TOKEN",
    purpose: "Inspect a token's total supply and its largest token accounts.",
    details: [
      "Top token accounts are not the same as unique holders.",
      "One person may control several accounts, or one account may be shared.",
    ],
  },
  {
    id: "tx-verifier",
    name: "TX Verifier",
    engine: "VERIFY",
    purpose: "Inspect a transaction signature's confirmation status, errors and slot.",
    details: [
      "\u201CNot found\u201D is reported as not found, never as failed.",
      "Shows the error recorded onchain, if any.",
    ],
  },
  {
    id: "account-checker",
    name: "Account Checker",
    engine: "VERIFY",
    purpose: "Check whether an account exists, its owning program, lamports and data size.",
    details: [
      "The owning program is not the human owner of a wallet.",
      "Reports existence plainly, without guessing intent.",
    ],
  },
];

TEMPLATES.push({
  id: "canvas",
  name: "Canvas",
  engine: "COMPOSE",
  purpose: "Chain 2–4 existing MCPX tools into one ordered pipeline.",
  details: [
    "Each later step reads one approved value (an address or signature) from an earlier step.",
    "No code, URLs or outside APIs. Created only together with a child-token launch.",
  ],
});

export const AVAILABILITY_NOTE = "Live status is checked with the execution service";

// ---------------------------------------------------------------------------
// Tool Library V2 — canonical registry for all ten library templates.
// `id` is the deployed catalogue id (mcp_creations.template_id / launch drafts) and is never renamed;
// `toolId` is the relay / worker id; `route` is the public tool page. Mappings are explicit, never derived.
// Availability is three separate capabilities, none of them a marketing flag:
//   tool_execution — decided at runtime by the tool's status endpoint (worker /ready); null = no tool exists
//   mcp_product    — true only when an MCP gateway adapter exists (checked against ADAPTERS by test)
//   token_launch   — true only when the launch form accepts the template (membership in TEMPLATES)
export type LibraryCategory = "Wallets" | "Tokens" | "Verification" | "Intelligence" | "Composition";
export const LIBRARY_CATEGORIES: LibraryCategory[] = ["Wallets", "Tokens", "Verification", "Intelligence", "Composition"];

export interface LibraryTemplate {
  id: string;
  name: string;
  category: LibraryCategory;
  tagline: string;
  benefit: string;
  toolId: string | null;
  route: string | null;
  mcpAdapter: boolean;
  tokenLaunch: boolean;
  /** Not built yet: never shows run, test or launch controls. */
  planned: boolean;
  image: string;
}


export const LIBRARY: LibraryTemplate[] = [
  { id: "wallet-inspector", name: "Wallet Inspector", category: "Wallets", tagline: "See what any wallet holds.", benefit: "SOL and token balances plus recent transactions for a Solana address, in one read.", toolId: "wallet_inspector", route: "/tools/wallet-inspector", mcpAdapter: true, tokenLaunch: true, planned: false, image: img_wallet_inspector },
  { id: "whale-watch", name: "Whale Watch", category: "Wallets", tagline: "Spot large moves on demand.", benefit: "Recent activity for a wallet, filtered to transfers or swaps above set thresholds.", toolId: "whale_watch", route: "/tools/whale-watch", mcpAdapter: true, tokenLaunch: true, planned: false, image: img_whale_watch },
  { id: "token-scanner", name: "Token Scanner", category: "Tokens", tagline: "Check who controls a token.", benefit: "Mint and freeze authority, supply and decimals, reported exactly as stored onchain.", toolId: "token_scanner", route: "/tools/token-scanner", mcpAdapter: false, tokenLaunch: true, planned: false, image: img_token_scanner },
  { id: "supply-monitor", name: "Supply Monitor", category: "Tokens", tagline: "Know where supply sits.", benefit: "Total supply and the largest token accounts — accounts, not unique holders.", toolId: "supply_monitor", route: "/tools/supply-monitor", mcpAdapter: false, tokenLaunch: true, planned: false, image: img_supply_monitor },
  { id: "tx-verifier", name: "Transaction Verifier", category: "Verification", tagline: "Confirm a transaction landed.", benefit: "Confirmation status, slot and any onchain error for a signature. Not found is never called failed.", toolId: "transaction_verifier", route: "/tools/transaction-verifier", mcpAdapter: false, tokenLaunch: true, planned: false, image: img_transaction_verifier },
  { id: "account-checker", name: "Account Checker", category: "Verification", tagline: "Check an account exists.", benefit: "Existence, owning program, lamports and data size for any account address.", toolId: "account_checker", route: "/tools/account-checker", mcpAdapter: false, tokenLaunch: true, planned: false, image: img_account_checker },
  { id: "holder-intelligence", name: "Holder Intelligence", category: "Intelligence", tagline: "Understand a token's holder base.", benefit: "Largest token accounts, their owner addresses and concentration against total supply — coverage stated, never a full holder count.", toolId: "holder_intelligence", route: "/tools/holder-intelligence", mcpAdapter: true, tokenLaunch: false, planned: false, image: img_holder_intelligence },
  { id: "token-risk-analyst", name: "Token Risk Analyst", category: "Intelligence", tagline: "Read a token's risk signals.", benefit: "Evidence checklist of authorities, Token-2022 extensions and concentration — observed, not observed or unknown. No score, no verdict.", toolId: "token_risk_analyst", route: "/tools/token-risk-analyst", mcpAdapter: true, tokenLaunch: false, planned: false, image: img_token_risk_analyst },
  { id: "smart-money-tracker", name: "Smart Money Tracker", category: "Intelligence", tagline: "Follow wallets you choose.", benefit: "Recent activity for up to 3 wallets you choose — signatures and native SOL transfers, larger moves highlighted. On demand, not monitoring.", toolId: "smart_money_tracker", route: "/tools/smart-money-tracker", mcpAdapter: true, tokenLaunch: false, planned: false, image: img_smart_money_tracker },
  { id: "onchain-report-builder", name: "Onchain Report Builder", category: "Intelligence", tagline: "Turn reads into a report.", benefit: "One sourced, point-in-time report for a wallet or token, built from existing MCPX tools. Partial parts are marked, never filled in.", toolId: "onchain_report_builder", route: "/tools/onchain-report-builder", mcpAdapter: true, tokenLaunch: false, planned: false, image: img_onchain_report_builder },
  // Template 11 (CANVAS-01): guided 2–4 step pipeline over src/lib/canvas/catalog.ts, configured inside the launch draft. No MCP adapter until a confirmed child launch exists.
  { id: "canvas", name: "Canvas", category: "Composition", tagline: "Chain existing tools in order.", benefit: "Combine 2–4 MCPX tools into one ordered pipeline, passing addresses between steps only through approved connections. Created only with a child-token launch.", toolId: null, route: null, mcpAdapter: false, tokenLaunch: true, planned: false, image: img_canvas },
];

// ---------------------------------------------------------------------------
// Launch deep links: /launch?template=<id>. Canonical id = LIBRARY/TEMPLATES id (never renamed).
// Legacy and relay spellings map explicitly to the canonical id.
export const TEMPLATE_ALIASES: Record<string, string> = Object.fromEntries([
  ...LIBRARY.flatMap((t) => [[t.id, t.id], ...(t.toolId ? [[t.toolId, t.id]] : [])]),
  ["transaction-verifier", "tx-verifier"],
  ["tx_verifier", "tx-verifier"],
]);

export type TemplateParam =
  | { kind: "none" }
  | { kind: "launchable"; id: string }
  | { kind: "not_launchable"; id: string; name: string }
  | { kind: "unknown"; raw: string };

/** Resolve a ?template= value. Only templates the launch form accepts become a preselection. */
export function resolveTemplateParam(raw: unknown): TemplateParam {
  if (typeof raw !== "string" || raw.trim() === "") return { kind: "none" };
  const v = raw.trim().toLowerCase().slice(0, 64);
  const id = TEMPLATE_ALIASES[v];
  if (!id) return { kind: "unknown", raw: v };
  const t = LIBRARY.find((x) => x.id === id)!;
  return t.tokenLaunch && TEMPLATES.some((x) => x.id === id) ? { kind: "launchable", id } : { kind: "not_launchable", id, name: t.name };
}
