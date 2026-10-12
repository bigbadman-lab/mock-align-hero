// Versioned template-adapter registry for the external MCP gateway.
// Adding a template = adding one adapter entry. No transport changes.
import * as z from "zod/v4";
import { WI_SCHEMA, WI_TOOL_ID, isValidSolanaAddress, isWalletInspectorResult } from "@/lib/tools/wallet-inspector";
import { WW_SCHEMA, WW_TOOL_ID, WW_THRESHOLDS, isWhaleWatchResult } from "@/lib/tools/whale-watch";

/** Server-validated, per-template product settings. Never contains URLs, programs or secrets. */
export type ProductSettings = Record<string, string>;

export interface TemplateAdapter {
  templateId: string; // stable catalogue id (matches mcp_creations.template_id)
  version: string; // adapter version; bump on any input/output contract change
  toolName: string; // MCP tool name exposed to clients
  workerToolId: string; // id the execution worker advertises on /ready
  title: string;
  description: string;
  /** External (caller-visible) input schema. Product-fixed values are NOT in here. */
  inputSchema: z.ZodObject<{ address: z.ZodString }>;
  /** Strict allowlist for product tool_config; returns null when invalid. */
  parseSettings(raw: unknown): ProductSettings | null;
  /** Public, human-readable description of server-fixed settings (safe to show; never raw config). */
  describeSettings(settings: ProductSettings): string[];
  /** Default settings for non-product (platform) endpoints. */
  defaultSettings: ProductSettings;
  /** Build the exact signed worker payload from validated input + server-fixed settings. */
  toWorkerPayload(input: Record<string, unknown>, settings: ProductSettings): string;
  /** Strict check of the worker response before it reaches the client. */
  validOutput(out: unknown, input: Record<string, unknown>, settings: ProductSettings): boolean;
}

const addressSchema = () =>
  z.string().min(32).max(44).refine(isValidSolanaAddress, "Must be a 32-byte base58 Solana public key").describe("Solana public address (base58).");

const isPlainObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

const walletInspector: TemplateAdapter = {
  templateId: "wallet-inspector",
  version: "1.0.0",
  toolName: "wallet_inspector",
  workerToolId: WI_TOOL_ID,
  title: "Wallet Inspector (Solana mainnet, read-only)",
  description:
    "Reads one Solana mainnet public address at 'confirmed' commitment: SOL balance and SPL Token / Token-2022 holdings (max 500 token accounts per program). " +
    "Read-only; never signs or writes. If any part could not be read, `partial` is true and `warnings`/`coverage` say which part — missing parts are not zero balances. " +
    "Amounts are exact integer strings (`amountRaw`) plus decimals. Shared rate limits apply.",
  inputSchema: z.strictObject({ address: addressSchema() }),
  parseSettings: (raw) => (isPlainObject(raw) && Object.keys(raw).length === 0 ? {} : null),
  describeSettings: () => ["No product-level settings: every caller gets the same read."],
  defaultSettings: {},
  toWorkerPayload: (i) => JSON.stringify({ schema: WI_SCHEMA, toolId: WI_TOOL_ID, input: { address: i["address"] } }),
  validOutput: (out, i) => isWalletInspectorResult(out, String(i["address"])),
};

const whaleWatch: TemplateAdapter = {
  templateId: "whale-watch",
  version: "1.0.0",
  toolName: "whale_watch",
  workerToolId: WW_TOOL_ID,
  title: "Whale Watch (Solana mainnet, read-only)",
  description:
    "Samples the latest 20 signatures for one Solana address, examines up to 10 transactions, and lists successful native SOL transfers at or above this product's fixed threshold. " +
    "A bounded sample, not monitoring; `complete` false means coverage was partial. Read-only. Shared rate limits apply.",
  inputSchema: z.strictObject({ address: addressSchema() }),
  parseSettings: (raw) => {
    if (!isPlainObject(raw) || Object.keys(raw).join(",") !== "minLamports") return null;
    const v = raw["minLamports"];
    return WW_THRESHOLDS.some((t) => t.lamports === v) ? { minLamports: v as string } : null;
  },
  describeSettings: (s) => {
    const t = WW_THRESHOLDS.find((x) => x.lamports === s["minLamports"]);
    return [`Minimum transfer reported: ${t ? t.label : "unknown"} — fixed by this product on the server; callers cannot change it.`];
  },
  defaultSettings: { minLamports: "1000000000" },
  toWorkerPayload: (i, s) => JSON.stringify({ schema: WW_SCHEMA, toolId: WW_TOOL_ID, input: { address: i["address"], minLamports: s["minLamports"] } }),
  validOutput: (out, i, s) => isWhaleWatchResult(out, String(i["address"]), String(s["minLamports"])),
};

/** All implemented adapters, keyed by templateId. */
export const ADAPTERS: Record<string, TemplateAdapter> = {
  [walletInspector.templateId]: walletInspector,
  [whaleWatch.templateId]: whaleWatch,
};

/** An endpoint profile = which templates (at which version) one MCP endpoint exposes. */
export interface EndpointProfile {
  id: string;
  kind: "platform-demo" | "creation";
  templates: { templateId: string; version: string }[];
}

export const PLATFORM_DEMO: EndpointProfile = {
  id: "platform-demo",
  kind: "platform-demo",
  templates: [{ templateId: "wallet-inspector", version: "1.0.0" }],
};

/** Resolves a profile to adapters; unknown or version-mismatched entries are skipped, never guessed. */
export function adaptersFor(profile: EndpointProfile): TemplateAdapter[] {
  return profile.templates.flatMap(({ templateId, version }) => {
    const a = ADAPTERS[templateId];
    return a && a.version === version ? [a] : [];
  });
}

/** Exact template+version lookup; no "latest". */
export function adapterExact(templateId: string, version: string): TemplateAdapter | null {
  const a = ADAPTERS[templateId];
  return a && a.version === version ? a : null;
}
