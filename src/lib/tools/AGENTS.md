# Tool relay rules

- Tool relays share src/lib/tools/relay.ts (website relays also pass their toolId for a per-tool daily free-test bucket, taken after shared buckets; MCP never passes it): one visitor+global rate-limit budget ("tools:*" buckets) across all tools, and a tool is enabled only when the worker's /ready lists its tool id — adding tools must never multiply capacity or show "live" before the worker is redeployed.
