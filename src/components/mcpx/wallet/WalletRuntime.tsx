// Browser-only. Loaded lazily behind <ClientOnly>; never imported during SSR.
// Global Buffer is installed by WalletBoundary before this module is loaded.
import { useEffect, useMemo, useRef, useState } from "react";
import { createAppKit, useAppKit, useAppKitAccount, useAppKitProvider, useAppKitNetwork, useDisconnect, useWalletInfo } from "@reown/appkit/react";
import { SolanaAdapter } from "@reown/appkit-adapter-solana/react";
import { solana as solanaNetwork } from "@reown/appkit/networks";
import type { AppKitNetwork } from "@reown/appkit/networks";

const solana = solanaNetwork as unknown as AppKitNetwork;
import { CONNECT_TIMEOUT_MS, REOWN_PROJECT_ID, deriveWalletStatus, type WalletView } from "@/lib/wallet/state";

declare global { interface Window { __mcpxAppKit?: boolean } }

function initOnce() {
  if (window.__mcpxAppKit) return;
  window.__mcpxAppKit = true;
  createAppKit({
    // SDK types conflict with this project's strict optional-property setting; runtime shape is correct.
    adapters: [new SolanaAdapter() as unknown as NonNullable<Parameters<typeof createAppKit>[0]["adapters"]>[number]],
    networks: [solana] as [AppKitNetwork],
    defaultNetwork: solana,
    projectId: REOWN_PROJECT_ID,
    metadata: {
      name: "MCPX",
      description: "MCPX — Solana-connected MCP tools. Every token powers a tool.",
      url: window.location.origin,
      icons: [],
    },
    themeMode: "dark",
    themeVariables: { "--w3m-accent": "#BBFF55", "--w3m-border-radius-master": "2px" },
    features: { analytics: false, email: false, socials: false, swaps: false, onramp: false, send: false, history: false },
    enableReconnect: true,
  });
}
initOnce();

// Renders nothing: reports wallet state upward so the page tree never remounts when the SDK loads.
export default function WalletRuntime({ onChange }: { onChange: (v: WalletView) => void }) {
  const { open } = useAppKit();
  const { address, isConnected, status } = useAppKitAccount({ namespace: "solana" });
  const { caipNetworkId, switchNetwork } = useAppKitNetwork();
  const { disconnect } = useDisconnect();
  const { walletInfo } = useWalletInfo();
  const { walletProvider } = useAppKitProvider<{ signMessage?: (m: Uint8Array) => Promise<Uint8Array> }>("solana");
  const [timedOut, setTimedOut] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const pending = status === "connecting" || status === "reconnecting";
  useEffect(() => {
    clearTimeout(timer.current);
    setTimedOut(false);
    if (pending) timer.current = setTimeout(() => setTimedOut(true), CONNECT_TIMEOUT_MS);
    return () => clearTimeout(timer.current);
  }, [pending]);

  // SDK hook functions are not referentially stable; keep them in a ref so the
  // reported view only changes when real wallet state changes (no render loops).
  const fns = useRef({ open, switchNetwork, disconnect, walletProvider });
  fns.current = { open, switchNetwork, disconnect, walletProvider };

  const view = useMemo<WalletView>(() => {
    const s = deriveWalletStatus({ isConnected, address, providerStatus: status, caipNetworkId, timedOut });
    const connected = s === "connected_mainnet" || s === "connected_unsupported_network";
    return {
      status: s,
      address: connected ? address : undefined,
      walletName: connected ? walletInfo?.name : undefined,
      message: s === "error" ? "The wallet didn't respond in time." : undefined,
      open: () => { setTimedOut(false); void fns.current.open({ view: "Connect", namespace: "solana" }); },
      openAccount: () => void fns.current.open({ view: "Account" }),
      switchToMainnet: () => void fns.current.switchNetwork(solana),
      disconnect: () => void fns.current.disconnect({ namespace: "solana" }),
      signMessage: connected
        ? async (m: Uint8Array) => {
            const p = fns.current.walletProvider;
            if (!p || typeof p.signMessage !== "function") throw new Error("unsupported_wallet");
            return p.signMessage(m);
          }
        : undefined,
    };
  }, [isConnected, address, status, caipNetworkId, timedOut, walletInfo?.name]);

  useEffect(() => { onChange(view); }, [view, onChange]);
  return null;
}
