// Deterministic mocks only — these do not prove a real wallet or real registry lifecycle.
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { WalletContext } from "@/lib/wallet/context";
import type { WalletView } from "@/lib/wallet/state";
import { TEMPLATES } from "@/lib/templates";

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, to }: { children: ReactNode; to: string }) => <a href={to}>{children}</a>,
}));

const fetchMock = vi.fn();
vi.mock("@/lib/registry", async (orig) => {
  const real = await orig<typeof import("@/lib/registry")>();
  return {
    ...real,
    verifiedCreationsQuery: (page = 0) => ({
      queryKey: ["registry", "verified-creations", page],
      queryFn: () => fetchMock(page),
      retry: false,
    }),
  };
});

import { WalletButton, WalletPanel } from "@/components/mcpx/wallet/WalletControls";
import { VerifiedRegistry } from "@/components/mcpx/VerifiedRegistry";

const A = "So11111111111111111111111111111111111111112";
const B = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";

function Both({ view }: { view: WalletView }) {
  return (
    <WalletContext.Provider value={view}>
      <header><WalletButton /></header>
      <WalletPanel />
    </WalletContext.Provider>
  );
}

beforeEach(() => { cleanup(); fetchMock.mockReset(); });

describe("wallet display contract", () => {
  it("header and panel show the same address; account switch and disconnect clear the old one", () => {
    const { rerender } = render(<Both view={{ status: "connected_mainnet", address: A }} />);
    expect(screen.getByText(A)).toBeTruthy();
    expect(screen.getByRole("button", { name: new RegExp(A) })).toBeTruthy();
    rerender(<Both view={{ status: "connected_mainnet", address: B }} />);
    expect(screen.queryByText(A)).toBeNull();
    expect(screen.getByText(B)).toBeTruthy();
    rerender(<Both view={{ status: "disconnected" }} />);
    expect(screen.queryByText(B)).toBeNull();
    expect(screen.getAllByRole("button", { name: "Connect Wallet" }).length).toBe(2);
  });

  it("unsupported network never shows mainnet", () => {
    render(<Both view={{ status: "connected_unsupported_network", address: A }} />);
    expect(screen.queryByText((_, el) => el?.tagName === "P" && /· Solana mainnet$|^Solana mainnet$/.test(el.textContent ?? ""))).toBeNull();
    expect(screen.getAllByText(/Unsupported network/).length).toBeGreaterThan(0);
  });

  it("explorer link opens safely", () => {
    render(<Both view={{ status: "connected_mainnet", address: A }} />);
    const link = screen.getByRole("link", { name: "View on Solscan" });
    expect(link.getAttribute("rel")).toBe("noopener noreferrer");
    expect(link.getAttribute("target")).toBe("_blank");
  });
});

function withQuery(ui: ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

describe("registry states", () => {
  it("successful [] shows a truthful empty state", async () => {
    fetchMock.mockResolvedValue({ status: "ok", items: [], page: 0, hasMore: false });
    withQuery(<VerifiedRegistry />);
    expect(await screen.findByText(/zero verified creations/)).toBeTruthy();
  });

  it("failure shows Retry, never zero; rapid taps make one request", async () => {
    let resolve!: (v: unknown) => void;
    fetchMock.mockResolvedValueOnce({ status: "unavailable", message: "The registry could not be reached." });
    withQuery(<><nav>Docs</nav><VerifiedRegistry /></>);
    const retry = await screen.findByRole("button", { name: "Retry" });
    expect(screen.queryByText(/zero verified creations/)).toBeNull();
    expect(screen.getByText("Docs")).toBeTruthy();
    fetchMock.mockImplementation(() => new Promise((r) => { resolve = r; }));
    fireEvent.click(retry); fireEvent.click(retry); fireEvent.click(retry);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    resolve({ status: "ok", items: [], page: 0, hasMore: false });
    expect(await screen.findByText(/zero verified creations/)).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("wallet changes do not refetch the public registry", async () => {
    fetchMock.mockResolvedValue({ status: "ok", items: [], page: 0, hasMore: false });
    const qc = new QueryClient();
    const ui = (v: WalletView) => (
      <QueryClientProvider client={qc}><Both view={v} /><VerifiedRegistry /></QueryClientProvider>
    );
    const { rerender } = render(ui({ status: "disconnected" }));
    await screen.findByText(/zero verified creations/);
    rerender(ui({ status: "connected_mainnet", address: A }));
    rerender(ui({ status: "disconnected" }));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("template definitions", () => {
  it("are exactly six with stable ids", () => {
    expect(TEMPLATES.map((t) => t.id)).toEqual([
      "wallet-inspector", "whale-watch", "token-scanner", "supply-monitor", "tx-verifier", "account-checker",
    ]);
  });
});
