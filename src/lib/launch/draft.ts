// Launch draft validation (Phase 04-C). Pure, browser-safe. A valid draft is a preference record only:
// it creates nothing, signs nothing and is never sent to the transaction builder in this phase.
import { TEMPLATES } from "@/lib/templates";
import { ADAPTERS } from "@/lib/mcp-gateway/registry";

/** Fixed fee split, server-owned. Shown read-only; never part of any browser input. */
export const FEE_SPLIT = Object.freeze([
  { role: "Creator", bps: 6000 },
  { role: "Tool operations", bps: 2500 },
  { role: "Platform", bps: 1500 },
]);

export const LIMITS = {
  productNameMax: 48, // MCPX limit (characters)
  toolDescriptionMax: 280, // optional MCP tool description (characters); DB CHECK matches
  tokenNameBytes: 32, // on-chain metadata name: builder allows ≤32 chars; we also cap UTF-8 bytes at 32
  symbolRe: /^[A-Za-z0-9]{1,10}$/, // builder rule
  descriptionBytes: 500, // MCPX limit for off-chain metadata description
  linkMax: 200, // builder uri limit
  buyMax: 1_000_000_000,
  slippageMinBps: 1,
  slippageMaxBps: 1000, // builder rule
} as const;

export interface DraftInput {
  templateId: string;
  settings: Record<string, string>;
  productName: string;
  /** Optional; older clients may omit it (treated as ""). */
  toolDescription?: string;
  tokenName: string;
  symbol: string;
  description: string;
  link: string;
  buyEnabled: boolean;
  buyAmount: string;
  slippageBps: string;
}

export interface Draft {
  templateId: string;
  templateName: string;
  settings: Record<string, string>;
  productName: string;
  toolDescription: string | null;
  tokenName: string;
  symbol: string;
  description: string;
  link: string | null;
  initialBuy: null | { amountMcp: string; slippageBps: number };
}

export type FieldErrors = Partial<Record<keyof DraftInput, string | undefined>>;

const utf8Len = (s: string) => new TextEncoder().encode(s).length;
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069\ufeff]/;

export function templateSettingsMode(templateId: string): "none" | "fixed" | "not_mcp" {
  const a = ADAPTERS[templateId];
  if (!a) return "not_mcp";
  return Object.keys(a.defaultSettings).length ? "fixed" : "none";
}

/** Safe link parsing: https only, public hostname, no credentials/IPs/localhost. Never fetched. */
export function checkLink(raw: string): string | null | { error: string } {
  const v = raw.trim();
  if (!v) return null;
  if (v.length > LIMITS.linkMax) return { error: `Link must be ${LIMITS.linkMax} characters or fewer.` };
  if (CONTROL.test(v) || /\s/.test(v)) return { error: "Link can't contain spaces or hidden characters." };
  let u: URL;
  try { u = new URL(v); } catch { return { error: "Enter a full address starting with https://." }; }
  if (u.protocol !== "https:") return { error: "Only https:// links are allowed." };
  if (u.username || u.password) return { error: "Links can't include a username or password." };
  if (u.port) return { error: "Links can't include a port number." };
  const h = u.hostname.toLowerCase();
  if (/^[\d.]+$/.test(h) || h.includes(":") || h.startsWith("[")) return { error: "Use a domain name, not an IP address." };
  if (!/^(?=.{4,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(h)) return { error: "Use a public domain name." };
  if (/(^|\.)(localhost|local|internal|lan|home|test|invalid|example)$/.test(h)) return { error: "Use a public domain name." };
  return u.toString();
}

export function validateDraft(i: DraftInput): { ok: true; draft: Draft } | { ok: false; errors: FieldErrors } {
  const e: FieldErrors = {};
  const t = TEMPLATES.find((x) => x.id === i.templateId);
  if (!t) e.templateId = "Choose one of the available templates.";

  let settings: Record<string, string> = {};
  if (t) {
    const a = ADAPTERS[t.id];
    if (!a) {
      if (Object.keys(i.settings).length) e.settings = "This template has no product settings.";
    } else {
      const parsed = a.parseSettings(i.settings);
      if (!parsed) e.settings = "That setting isn't allowed for this template.";
      else settings = parsed;
    }
  }

  const pn = i.productName;
  if (!pn.trim()) e.productName = "Enter a product name.";
  else if (pn !== pn.trim()) e.productName = "Remove spaces at the start or end.";
  else if (CONTROL.test(pn)) e.productName = "Remove hidden or control characters.";
  else if ([...pn].length > LIMITS.productNameMax) e.productName = `Use ${LIMITS.productNameMax} characters or fewer.`;

  const td = (i.toolDescription ?? "").trim();
  if (CONTROL.test(td)) e.toolDescription = "Remove hidden or control characters (including line breaks).";
  else if ([...td].length > LIMITS.toolDescriptionMax) e.toolDescription = `Use ${LIMITS.toolDescriptionMax} characters or fewer.`;

  const tn = i.tokenName;
  if (!tn.trim()) e.tokenName = "Enter a token name.";
  else if (tn !== tn.trim()) e.tokenName = "Remove spaces at the start or end.";
  else if (CONTROL.test(tn)) e.tokenName = "Remove hidden or control characters.";
  else if (tn.length > 32 || utf8Len(tn) > LIMITS.tokenNameBytes) e.tokenName = `Too long: ${utf8Len(tn)} of ${LIMITS.tokenNameBytes} bytes (emoji and accented letters use more than one).`;

  if (!LIMITS.symbolRe.test(i.symbol)) e.symbol = "Use 1–10 letters or numbers, no spaces or symbols.";

  const d = i.description;
  if (!d.trim()) e.description = "Enter a short description.";
  else if (CONTROL.test(d.replace(/\n/g, ""))) e.description = "Remove hidden or control characters.";
  else if (utf8Len(d.trim()) > LIMITS.descriptionBytes) e.description = `Too long: ${utf8Len(d.trim())} of ${LIMITS.descriptionBytes} bytes.`;

  const link = checkLink(i.link);
  if (link && typeof link === "object") e.link = link.error;

  let initialBuy: Draft["initialBuy"] = null;
  if (i.buyEnabled) {
    const amt = i.buyAmount.trim();
    const slip = Number(i.slippageBps);
    if (!/^(0|[1-9]\d{0,9})(\.\d{1,9})?$/.test(amt) || Number(amt) <= 0) e.buyAmount = "Enter a positive amount, up to 9 decimal places.";
    else if (Number(amt) > LIMITS.buyMax) e.buyAmount = `Maximum is ${LIMITS.buyMax.toLocaleString("en-US")}.`;
    if (!/^\d{1,4}$/.test(i.slippageBps) || slip < LIMITS.slippageMinBps || slip > LIMITS.slippageMaxBps) e.slippageBps = "Slippage must be between 1 and 1000 basis points (0.01%–10%).";
    if (!e.buyAmount && !e.slippageBps) initialBuy = { amountMcp: amt, slippageBps: slip };
  }

  if (Object.keys(e).length || !t) return { ok: false, errors: e };
  return {
    ok: true,
    draft: {
      templateId: t.id, templateName: t.name, settings, productName: pn, toolDescription: td || null, tokenName: tn, symbol: i.symbol,
      description: d.trim(), link: typeof link === "string" ? link : null, initialBuy,
    },
  };
}

export function draftSummary(d: Draft, settingsText: string[], wallet: string | null): string {
  return [
    "MCPX launch draft — preparation only, nothing created or signed",
    `Template: ${d.templateName} (${d.templateId})`,
    ...settingsText.map((s) => `Setting: ${s}`),
    `Product: ${d.productName}`,
    `Tool description: ${d.toolDescription ?? "none"}`,
    `Token: ${d.tokenName} (${d.symbol})`,
    `Description: ${d.description}`,
    `Link: ${d.link ?? "none"}`,
    `Creator wallet: ${wallet ?? "not connected"}`,
    `Fee split: ${FEE_SPLIT.map((f) => `${f.bps / 100}% ${f.role.toLowerCase()}`).join(" / ")} (fixed by MCPX)`,
    d.initialBuy
      ? `Initial buy preference: ${d.initialBuy.amountMcp} $MCP, slippage ${d.initialBuy.slippageBps} bps — separate purchase after verified creation; not part of creation transaction`
      : "Initial buy: none",
  ].join("\n");
}
