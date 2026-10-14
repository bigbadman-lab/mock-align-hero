// The site's one mainnet RPC: explicit override, else the paid Helius key. The free public endpoint refuses
// hosted servers, so it is only a last resort.
export function siteRpcUrl(): string {
  const helius = process.env["MCPX_HELIUS_TEST_API_KEY"];
  return process.env["MCPX_SOLANA_RPC_URL"] || (helius ? `https://mainnet.helius-rpc.com/?api-key=${encodeURIComponent(helius)}` : "https://api.mainnet-beta.solana.com");
}
