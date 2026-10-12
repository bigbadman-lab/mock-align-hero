// Versioned template-adapter registry for the external MCP gateway.
// Adding a template = adding one adapter entry + listing it on an endpoint profile. No transport changes.
import * as z from "zod/v4";
import { WI_SCHEMA, WI_TOOL_ID, isValidSolanaAddress, isWalletInspectorResult } from "@/lib/tools/wallet-inspector";

export interface TemplateAdapter {
  templateId: string; // stable catalogue id
  version: string; // adapter version; bump on any input/output contract change
  toolName: string; // MCP tool name exposed to clients
  workerToolId: string; // id the execution worker advertises on /ready
  title: string;
  description: string;
  inputSchema: z.ZodObject;
  /** Build the exact signed worker payload from already-validated input. */
  toWorkerPayload(input: Record<string, unknown>): string;
  /** Strict check of the worker response before it reaches the client. */
  validOutput(out: unknown, input: Record<string, unknown>): boolean;
}

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
  inputSchema: z.strictObject({
    address: z.string().min(32).max(44).refine(isValidSolanaAddress, "Must be a 32-byte base58 Solana public key").describe("Solana public address (base58)."),
  }),
  toWorkerPayload: (i) => JSON.stringify({ schema: WI_SCHEMA, toolId: WI_TOOL_ID, input: { address: i.address } }),
  validOutput: (out, i) => isWalletInspectorResult(out, String(i.address)),
};

/** All implemented adapters, keyed by templateId. */
export const ADAPTERS: Record<string, TemplateAdapter> = { [walletInspector.templateId]: walletInspector };

/** An endpoint profile = which templates (at which version) one MCP endpoint exposes. */
export interface EndpointProfile {
  id: string;
  kind: "platform-demo" | "creation"; // "creation" profiles come only from verified registry rows (future)
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
