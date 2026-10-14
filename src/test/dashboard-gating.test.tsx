// Dashboard gating: every dashboard area stays hidden until the creator session is signed in.
// Deterministic fetch mocks only — these prove the UI contract, not a real wallet signature.
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, cleanup } from "@testing-library/react";
import type { ReactNode } from "react";
import { WalletContext } from "@/lib/wallet/context";
import type { WalletView } from "@/lib/wallet/state";

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => () => ({}),
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

const HIDDEN = ["Canvas workspace", "Verified MCP creations", "Coming in later phases"];

function renderDashboard() {
  const view: WalletView = { status: "loading" };
  return render(
    <WalletContext.Provider value={view}>
      <Dashboard />
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

    await waitFor(() => expect(screen.getByText("Your dashboard areas")).toBeInTheDocument());
    for (const area of HIDDEN) {
      expect(screen.queryByText(area)).toBeNull();
    }
    // The way in must stay reachable.
    expect(screen.getByText("Creator management")).toBeInTheDocument();
  });

  it("shows the dashboard areas once a creator session is signed in", async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url === "/api/auth/session") return jsonResponse({ signedIn: true, wallet: WALLET, expiresAt: new Date(Date.now() + 600_000).toISOString() });
      if (url === "/api/creator/products") return jsonResponse({ products: [] });
      if (url === "/api/creator/canvas") return jsonResponse({ available: false, products: [] });
      return jsonResponse({}, 401);
    });

    renderDashboard();

    await waitFor(() => expect(screen.getByText("Canvas workspace")).toBeInTheDocument());
    expect(screen.getByText("Verified MCP creations")).toBeInTheDocument();
    expect(screen.getByText("Coming in later phases")).toBeInTheDocument();
    expect(screen.queryByText("Your dashboard areas")).toBeNull();
  });
});
