// Browser-only. Loaded lazily behind <ClientOnly>; never imported during SSR.
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createAppKit, useAppKit, useAppKitAccount, useAppKitNetwork, useDisconnect, useWalletInfo } from "@reown/appkit/react";
import { SolanaAdapter } from "@reown/appkit-adapter-solana/react";
import { solana } from "@reown/appkit/networks";
import { WalletContext } from "@/lib/wallet/context";
import { CONNECT_TIMEOUT_MS, REOWN_PROJECT_ID, deriveWalletStatus, type WalletView } from "@/lib/wallet/state";

declare global { interface Window { __mcpxAppKit?: boolean } }

function initOnce() {
  if (window.__mcpxAppKit) return;
  window.__mcpxAppKit = true;
  createAppKit({
    adapters: [new SolanaAdapter()],
    networks: [solana],
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

export default function WalletRuntime({ children }: { children: ReactNode }) {
  const { open } = useAppKit();
  const { address, isConnected, status } = useAppKitAccount({ namespace: "solana" });
  const { caipNetworkId, switchNetwork } = useAppKitNetwork();
  const { disconnect } = useDisconnect();
  const { walletInfo } = useWalletInfo();
  const [timedOut, setTimedOut] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>();

  const pending = status === "connecting" || status === "reconnecting";
  useEffect(() => {
    clearTimeout(timer.current);
    setTimedOut(false);
    if (pending) timer.current = setTimeout(() => setTimedOut(true), CONNECT_TIMEOUT_MS);
    return () => clearTimeout(timer.current);
  }, [pending]);

  const view = useMemo<WalletView>(() => {
    const s = deriveWalletStatus({ isConnected, address, providerStatus: status, caipNetworkId, timedOut });
    const connected = s === "connected_mainnet" || s === "connected_unsupported_network";
    return {
      status: s,
      address: connected ? address : undefined,
      walletName: connected ? walletInfo?.name : undefined,
      message: s === "error" ? "The wallet didn't respond in time." : undefined,
      open: () => { setTimedOut(false); void open({ view: "Connect", namespace: "solana" }); },
      openAccount: () => void open({ view: "Account" }),
      switchToMainnet: () => void switchNetwork(solana),
      disconnect: () => void disconnect({ namespace: "solana" }),
    };
  }, [isConnected, address, status, caipNetworkId, timedOut, walletInfo?.name, open, switchNetwork, disconnect]);

  return <WalletContext.Provider value={view}>{children}</WalletContext.Provider>;
}
