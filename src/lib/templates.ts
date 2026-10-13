// Static product-definition catalogue. These are planned templates,
// launchable via the launch form. Live availability is never stored here.
export type Engine = "WALLET" | "TOKEN" | "VERIFY";

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

export const AVAILABILITY_NOTE = "Live status is checked with the execution service";

// ---------------------------------------------------------------------------
// Tool Library V2 — canonical registry for all ten library templates.
// `id` is the deployed catalogue id (mcp_creations.template_id / launch drafts) and is never renamed;
// `toolId` is the relay / worker id; `route` is the public tool page. Mappings are explicit, never derived.
// Availability is three separate capabilities, none of them a marketing flag:
//   tool_execution — decided at runtime by the tool's status endpoint (worker /ready); null = no tool exists
//   mcp_product    — true only when an MCP gateway adapter exists (checked against ADAPTERS by test)
//   token_launch   — true only when the launch form accepts the template (membership in TEMPLATES)
export type LibraryCategory = "Wallets" | "Tokens" | "Verification" | "Intelligence";
export const LIBRARY_CATEGORIES: LibraryCategory[] = ["Wallets", "Tokens", "Verification", "Intelligence"];

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

const img = (n: string) => new URL(`../assets/templates/${n}.jpg`, import.meta.url).href;

export const LIBRARY: LibraryTemplate[] = [
  { id: "wallet-inspector", name: "Wallet Inspector", category: "Wallets", tagline: "See what any wallet holds.", benefit: "SOL and token balances plus recent transactions for a Solana address, in one read.", toolId: "wallet_inspector", route: "/tools/wallet-inspector", mcpAdapter: true, tokenLaunch: true, planned: false, image: img("wallet-inspector") },
  { id: "whale-watch", name: "Whale Watch", category: "Wallets", tagline: "Spot large moves on demand.", benefit: "Recent activity for a wallet, filtered to transfers or swaps above set thresholds.", toolId: "whale_watch", route: "/tools/whale-watch", mcpAdapter: true, tokenLaunch: true, planned: false, image: img("whale-watch") },
  { id: "token-scanner", name: "Token Scanner", category: "Tokens", tagline: "Check who controls a token.", benefit: "Mint and freeze authority, supply and decimals, reported exactly as stored onchain.", toolId: "token_scanner", route: "/tools/token-scanner", mcpAdapter: false, tokenLaunch: true, planned: false, image: img("token-scanner") },
  { id: "supply-monitor", name: "Supply Monitor", category: "Tokens", tagline: "Know where supply sits.", benefit: "Total supply and the largest token accounts — accounts, not unique holders.", toolId: "supply_monitor", route: "/tools/supply-monitor", mcpAdapter: false, tokenLaunch: true, planned: false, image: img("supply-monitor") },
  { id: "tx-verifier", name: "Transaction Verifier", category: "Verification", tagline: "Confirm a transaction landed.", benefit: "Confirmation status, slot and any onchain error for a signature. Not found is never called failed.", toolId: "transaction_verifier", route: "/tools/transaction-verifier", mcpAdapter: false, tokenLaunch: true, planned: false, image: img("transaction-verifier") },
  { id: "account-checker", name: "Account Checker", category: "Verification", tagline: "Check an account exists.", benefit: "Existence, owning program, lamports and data size for any account address.", toolId: "account_checker", route: "/tools/account-checker", mcpAdapter: false, tokenLaunch: true, planned: false, image: img("account-checker") },
  { id: "holder-intelligence", name: "Holder Intelligence", category: "Intelligence", tagline: "Understand a token's holder base.", benefit: "Planned: holder concentration and distribution built from complete history, not top-account snapshots.", toolId: null, route: null, mcpAdapter: false, tokenLaunch: false, planned: true, image: img("holder-intelligence") },
  { id: "token-risk-analyst", name: "Token Risk Analyst", category: "Intelligence", tagline: "Read a token's risk signals.", benefit: "Planned: authority, supply and concentration checks combined into one plain-language review.", toolId: null, route: null, mcpAdapter: false, tokenLaunch: false, planned: true, image: img("token-risk-analyst") },
  { id: "smart-money-tracker", name: "Smart Money Tracker", category: "Intelligence", tagline: "Follow wallets you choose.", benefit: "Planned: activity across a watchlist of wallets you supply. No ranking claims without a source.", toolId: null, route: null, mcpAdapter: false, tokenLaunch: false, planned: true, image: img("smart-money-tracker") },
  { id: "onchain-report-builder", name: "Onchain Report Builder", category: "Intelligence", tagline: "Turn reads into a report.", benefit: "Planned: combine results from other tools into one shareable, sourced report.", toolId: null, route: null, mcpAdapter: false, tokenLaunch: false, planned: true, image: img("onchain-report-builder") },
];
