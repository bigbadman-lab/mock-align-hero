// Static product-definition catalogue. These are planned templates,
// NOT deployed tools and NOT live data.
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

export const AVAILABILITY_NOTE = "Template preview \u00B7 Execution arrives in Phase 02";
