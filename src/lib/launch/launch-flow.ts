// Launch button rules (browser-safe). The server re-checks everything; this only decides what the
// creator sees. Launching stays off until the server reports child launching enabled.
export type LaunchGate = {
  serverEnabled: boolean;
  signedInWallet: string | null;
  connectedWallet: string | null;
  metadataReady: boolean;
};

export type LaunchBlocker = "launch_closed" | "sign_in" | "connect_wallet" | "wallet_mismatch" | "not_ready" | null;

export function launchBlocker(g: LaunchGate): LaunchBlocker {
  if (!g.serverEnabled) return "launch_closed";
  if (!g.signedInWallet) return "sign_in";
  if (!g.connectedWallet) return "connect_wallet";
  if (g.connectedWallet !== g.signedInWallet) return "wallet_mismatch";
  if (!g.metadataReady) return "not_ready";
  return null;
}

export const BLOCKER_TEXT: Record<Exclude<LaunchBlocker, null>, string> = {
  launch_closed: "Launching opens soon. Your launch is saved and ready. Nothing is signed or sent until launching opens.",
  sign_in: "Sign in as a creator from the Dashboard to launch.",
  connect_wallet: "Connect your wallet on Solana mainnet to launch.",
  wallet_mismatch: "The connected wallet isn't the one you signed in with.",
  not_ready: "Add artwork, then press Review again to finish preparing your launch.",
};

export type LaunchStage = "preparing" | "checking" | "signing" | "confirming" | "live";
export const STAGES: { id: LaunchStage; label: string }[] = [
  { id: "preparing", label: "Preparing your launch" },
  { id: "checking", label: "Checking fee sharing and creator wallet" },
  { id: "signing", label: "Waiting for your wallet signature" },
  { id: "confirming", label: "Confirming on Solana" },
  { id: "live", label: "Your token is live" },
];

/** A claim is shown as live only when verified on-chain and linked to a product page. */
export function claimOutcome(c: { status?: unknown; slug?: unknown }): "live" | "rejected" | "pending" {
  if (c.status === "VERIFIED" && typeof c.slug === "string" && c.slug) return "live";
  if (c.status === "REJECTED") return "rejected";
  return "pending";
}
