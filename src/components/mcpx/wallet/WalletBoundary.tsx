import { ClientOnly } from "@tanstack/react-router";
import { Component, lazy, Suspense, type ReactNode } from "react";
import { WalletContext } from "@/lib/wallet/context";

const WalletRuntime = lazy(async () => {
  // Must run before any @reown/@solana module evaluates.
  const { installBufferPolyfill } = await import("./bufferPolyfill");
  installBufferPolyfill();
  return import("./WalletRuntime");
});

const Unavailable = ({ children }: { children: ReactNode }) => (
  <WalletContext.Provider value={{ status: "unavailable", message: "Wallet connection couldn't load. The rest of the site works normally." }}>
    {children}
  </WalletContext.Provider>
);

// Contains any wallet SDK failure: children render again with "unavailable" state.
class Guard extends Component<{ children: ReactNode; fallback: ReactNode }, { failed: boolean }> {
  override state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  override componentDidCatch(e: unknown) { console.warn("Wallet runtime failed", e); }
  override render() { return this.state.failed ? this.props.fallback : this.props.children; }
}

export function WalletBoundary({ children }: { children: ReactNode }) {
  return (
    <ClientOnly fallback={children}>
      <Guard fallback={<Unavailable>{children}</Unavailable>}>
        <Suspense fallback={children}>
          <WalletRuntime>{children}</WalletRuntime>
        </Suspense>
      </Guard>
    </ClientOnly>
  );
}
