// Dashboard gating: every dashboard area stays hidden until the creator session is signed in.
// Deterministic fetch mocks only — these prove the UI contract, not a real wallet signature.
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, cleanup } from "@testing-library/react";
import type { ReactNode } from "react";
import { WalletContext } from "@/lib/wallet/context";
import type { WalletView } from "@/lib/wallet/state";
import { CreatorSessionProvider } from "@/lib/creator-auth/session-context";

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => () => ({}),
  useNavigate: () => () => {},
  Link: ({ children, to }: { children: ReactNode; to: string }) => <a href={to}>{children}</a>,
}));

const WALLET = "So11111111111111111111111111111111111111112";
const fetchMock = vi.fn();

function jsonResponse(body: unknown, status = 200) {
  return { ok: status < 400, status, json: async () => body };
}

beforeEach(() => {
  cleanup();
  fetchMock.mockReset();
  globalThis.fetch = fetchMock as unknown as typeof fetch;
});

afterEach(() => { vi.restoreAllMocks(); });

const HIDDEN = ["Canvas workspace", "Verified MCP creations", "Verified creator"];

function renderDashboard(view: WalletView = { status: "disconnected", open: () => {} }) {
  return render(
    <WalletContext.Provider value={view}>
      <CreatorSessionProvider><Dashboard /></CreatorSessionProvider>
    </WalletContext.Provider>,
  );
}

import { Dashboard } from "@/routes/dashboard";

describe("dashboard session gating", () => {
  it("hides every dashboard area while no creator session is signed in", async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url === "/api/auth/session") return jsonResponse({ signedIn: false });
      return jsonResponse({}, 401);
    });

    renderDashboard();

    await waitFor(() => expect(screen.getByText("Your creator workspace")).toBeInTheDocument());
    for (const area of HIDDEN) {
      expect(screen.queryByText(area)).toBeNull();
    }
    // The way in must stay reachable.
    expect(screen.getByRole("button", { name: "Connect & Sign In" })).toBeInTheDocument();
  });

  it("shows the dashboard areas once a creator session is signed in", async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url === "/api/auth/session") return jsonResponse({ signedIn: true, wallet: WALLET, expiresAt: new Date(Date.now() + 600_000).toISOString() });
      if (url === "/api/creator/products") return jsonResponse({ products: [] });
      if (url === "/api/creator/canvas") return jsonResponse({ available: false, products: [] });
      return jsonResponse({}, 401);
    });

    renderDashboard({ status: "connected_mainnet", address: WALLET });

    await waitFor(() => expect(screen.getByText("Canvas workspace")).toBeInTheDocument());
    expect(screen.getByText("Verified MCP creations")).toBeInTheDocument();
    expect(screen.queryByText("Your creator workspace")).toBeNull();
  });

  it("a connected wallet without a session sees Verify Wallet, not the dashboard, and nothing is signed", async () => {
    const signMessage = vi.fn();
    fetchMock.mockImplementation(async (url: string) => url === "/api/auth/session" ? jsonResponse({ signedIn: false }) : jsonResponse({}, 401));
    renderDashboard({ status: "connected_mainnet", address: WALLET, signMessage });
    await waitFor(() => expect(screen.getByRole("button", { name: "Verify Wallet" })).toBeInTheDocument());
    expect(screen.queryByText("Verified MCP creations")).toBeNull();
    expect(signMessage).not.toHaveBeenCalled();
  });

  it("a session for a different wallet never opens the dashboard", async () => {
    fetchMock.mockImplementation(async (url: string) => url === "/api/auth/session"
      ? jsonResponse({ signedIn: true, wallet: WALLET, expiresAt: new Date(Date.now() + 600_000).toISOString() }) : jsonResponse({}, 200));
    renderDashboard({ status: "connected_mainnet", address: "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin" });
    await waitFor(() => expect(screen.getByRole("button", { name: "Verify Wallet" })).toBeInTheDocument());
    expect(screen.queryByText("Verified MCP creations")).toBeNull();
  });
});

import { safeNext } from "@/lib/creator-auth/session-context";
describe("post-verify destination", () => {
  it("allows same-site paths only", () => {
    expect(safeNext("/launch")).toBe("/launch");
    expect(safeNext("//evil.com")).toBeNull();
    expect(safeNext("https://evil.com")).toBeNull();
    expect(safeNext("/\\evil.com")).toBeNull();
  });
});
