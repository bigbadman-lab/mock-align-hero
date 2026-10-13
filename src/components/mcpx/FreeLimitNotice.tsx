import { Link } from "@tanstack/react-router";

// Shown when a visitor has used their daily free website tests for a tool.
export function FreeLimitNotice() {
  return (
    <p className="mt-2">
      Free tests reset at midnight UTC. To keep using this tool, launch your own $MCP-backed token with it.{" "}
      <Link to="/launch" className="text-primary underline underline-offset-4">Launch a token</Link>
    </p>
  );
}
