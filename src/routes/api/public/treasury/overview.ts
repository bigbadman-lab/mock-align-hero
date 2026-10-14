// TREASURY-01 public read-only projection (sanitized; never executes or mutates anything).
import { createFileRoute } from "@tanstack/react-router";
import { treasuryReply } from "@/lib/treasury/http.server";

export const Route = createFileRoute("/api/public/treasury/overview")({
  server: { handlers: { GET: async ({ request }) => treasuryReply(request, "overview") } },
});
