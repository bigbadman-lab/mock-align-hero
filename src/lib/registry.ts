// Public read contract for the verified creations registry.
// Reads only safe public columns; no polling, no realtime, no writes.
import { queryOptions } from "@tanstack/react-query";

export const REGISTRY_PAGE_SIZE = 25;

export interface VerifiedCreationSummary {
  id: string;
  slug: string;
  template_id: string;
  template_version: number;
  display_name: string;
  ticker: string;
  child_mint: string;
  network: string;
  verified_at: string;
}

export type RegistryFailure = "unavailable" | "schema_missing" | "access_denied" | "error";

export type CreationListResult =
  | { status: "ok"; items: VerifiedCreationSummary[]; page: number; hasMore: boolean }
  | { status: RegistryFailure; message: string };

export const PUBLIC_COLUMNS =
  "id,slug,template_id,template_version,display_name,ticker,child_mint,network,verified_at";

export function classifyRegistryError(err: { code?: string; message?: string } | null | undefined): RegistryFailure {
  const code = err?.code ?? "";
  if (code === "42P01" || code === "PGRST205") return "schema_missing";
  if (code === "42501" || code === "PGRST301") return "access_denied";
  if (!code || /fetch|network|timeout|abort/i.test(err?.message ?? "")) return "unavailable";
  return "error";
}

const MESSAGES: Record<RegistryFailure, string> = {
  unavailable: "The registry could not be reached.",
  schema_missing: "The registry is not set up on this server yet.",
  access_denied: "The registry refused this request.",
  error: "The registry returned an unexpected error.",
};

export async function fetchVerifiedCreations(page: number, signal?: AbortSignal): Promise<CreationListResult> {
  const started = Date.now();
  const diag = (outcome: string) => {
    // Dev-only, sanitized: category + elapsed ms. No payloads, keys or addresses.
    if (import.meta.env.DEV) console.debug(`[registry] page=${safePage} outcome=${outcome} ms=${Date.now() - started}`);
  };
  const safePage = Math.max(0, Math.min(Math.floor(page) || 0, 400));
  try {
    const { supabase } = await import("@/integrations/supabase/client");
    const from = safePage * REGISTRY_PAGE_SIZE;
    let q = supabase
      .from("mcp_creations")
      .select(PUBLIC_COLUMNS)
      .order("verified_at", { ascending: false })
      .order("id", { ascending: false })
      .range(from, from + REGISTRY_PAGE_SIZE); // one extra row to detect more
    if (signal) q = q.abortSignal(signal);
    const { data, error } = await q;
    if (error) {
      const kind = classifyRegistryError(error);
      diag(kind);
      return { status: kind, message: MESSAGES[kind] };
    }
    const rows = (data ?? []) as VerifiedCreationSummary[];
    diag(`ok:${Math.min(rows.length, REGISTRY_PAGE_SIZE)}`);
    return { status: "ok", items: rows.slice(0, REGISTRY_PAGE_SIZE), page: safePage, hasMore: rows.length > REGISTRY_PAGE_SIZE };
  } catch {
    diag("unavailable");
    return { status: "unavailable", message: MESSAGES.unavailable };
  }
}

export const verifiedCreationsQuery = (page = 0) =>
  queryOptions({
    queryKey: ["registry", "verified-creations", page],
    queryFn: ({ signal }) => {
      const timeout = AbortSignal.timeout(10_000);
      const s = AbortSignal.any ? AbortSignal.any([signal, timeout]) : signal;
      return fetchVerifiedCreations(page, s);
    },
    staleTime: 5 * 60_000,
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    refetchInterval: false,
  });
