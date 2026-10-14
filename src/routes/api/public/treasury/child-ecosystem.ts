// TREASURY-01 public read-only projection (sanitized; never executes or mutates anything).
import { createFileRoute } from "@tanstack/react-router";
import { treasuryReply } from "@/lib/treasury/http.server";

export const Route = createFileRoute("/api/public/treasury/child-ecosystem")({
  server: { handlers: { GET: async ({ request }) => treasuryReply(request, "child-ecosystem") } },
});
