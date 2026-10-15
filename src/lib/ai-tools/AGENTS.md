# ai-tools

- AI tools (Entertainment + AI Playground): all definitions in src/lib/ai-tools/defs.ts run through one server-side OpenAI adapter (src/lib/ai-tools/execute.ts) using the platform OPENAI_API_KEY, with a kill switch (MCPX_AI_TOOLS_DISABLED=1), platform-wide per-minute/per-day caps via mcpx_rate_limit_take, per-isolate concurrency and token caps; MCP adapters mark them engine "ai" so the gateway and product runner skip the Solana worker but keep the same auth, shared buckets and free-test bucket — so MCP access never means unlimited AI spend.
