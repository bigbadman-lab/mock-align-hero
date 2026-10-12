import { ClientOnly } from "@tanstack/react-router";
import { Component, lazy, Suspense, useCallback, useState, type ReactNode } from "react";
import { WalletContext } from "@/lib/wallet/context";
import type { WalletView } from "@/lib/wallet/state";

const WalletRuntime = lazy(async () => {
  // Must run before any @reown/@solana module evaluates.
  // Wallet SDK code calls the global Buffer; browsers have none.
  const { Buffer } = await import("buffer");
  const g = globalThis as typeof globalThis & { Buffer?: typeof Buffer };
  if (!g.Buffer) g.Buffer = Buffer;
  return import("./WalletRuntime");
});

const UNAVAILABLE: WalletView = { status: "unavailable", message: "Wallet connection couldn't load. The rest of the site works normally." };

// Contains any wallet SDK failure; reports "unavailable" instead.
class Guard extends Component<{ children: ReactNode; onFail: () => void }, { failed: boolean }> {
  override state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  override componentDidCatch(e: unknown) { console.warn("Wallet runtime failed", e instanceof Error ? e.message : "unknown"); this.props.onFail(); }
  override render() { return this.state.failed ? null : this.props.children; }
}

// Page content is always rendered in the same position, so loading or failing
// the wallet SDK never remounts routes (no duplicate data requests).
export function WalletBoundary({ children }: { children: ReactNode }) {
  const [view, setView] = useState<WalletView>({ status: "loading" });
  const fail = useCallback(() => setView(UNAVAILABLE), []);
  return (
    <WalletContext.Provider value={view}>
      {children}
      <ClientOnly fallback={null}>
        <Guard onFail={fail}>
          <Suspense fallback={null}>
            <WalletRuntime onChange={setView} />
          </Suspense>
        </Guard>
      </ClientOnly>
    </WalletContext.Provider>
  );
}
