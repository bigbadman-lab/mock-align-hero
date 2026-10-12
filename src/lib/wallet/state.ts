// Browser-safe wallet contract. No Reown imports here, so it is safe for SSR and tests.
// A connected wallet is NOT an authenticated MCPX/Cloud identity.

// Public configuration (not a secret). Reown project IDs are meant to ship to the browser.
export const REOWN_PROJECT_ID = "ed2af8a5ab7949914d93f72cc3b2aaf3";
export const SOLANA_MAINNET_CAIP = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
export const CONNECT_TIMEOUT_MS = 30_000;

export type WalletStatus =
  | "loading"
  | "unavailable"
  | "disconnected"
  | "connecting"
  | "connected_mainnet"
  | "connected_unsupported_network"
  | "error";

export interface WalletView {
  status: WalletStatus;
  address?: string | undefined;
  walletName?: string | undefined;
  message?: string | undefined;
  open?: (() => void) | undefined;
  openAccount?: (() => void) | undefined;
  switchToMainnet?: (() => void) | undefined;
  disconnect?: (() => void) | undefined;
}

const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export function deriveWalletStatus(input: {
  isConnected: boolean;
  address?: string | null | undefined;
  providerStatus?: string | undefined;
  caipNetworkId?: string | null | undefined;
  timedOut?: boolean | undefined;
}): Exclude<WalletStatus, "loading" | "unavailable"> {
  const { isConnected, address, providerStatus, caipNetworkId, timedOut } = input;
  if (isConnected && address && BASE58.test(address)) {
    return caipNetworkId === SOLANA_MAINNET_CAIP ? "connected_mainnet" : "connected_unsupported_network";
  }
  if (providerStatus === "connecting" || providerStatus === "reconnecting") return timedOut ? "error" : "connecting";
  return "disconnected";
}

export function shortAddress(a: string) {
  return a.length > 10 ? `${a.slice(0, 4)}…${a.slice(-4)}` : a;
}

export function explorerAccountUrl(address: string) {
  if (!BASE58.test(address)) return null;
  return `https://solscan.io/account/${encodeURIComponent(address)}`;
}
