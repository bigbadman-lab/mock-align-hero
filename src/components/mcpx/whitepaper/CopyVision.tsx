import { useRef, useState } from "react";
import { Check, Copy } from "lucide-react";
import { Button } from "@/components/ui/button";

export const VISION_SUMMARY = `MCPX — The Open Marketplace for Token-Powered Applications
Whitepaper: Working Draft v0.1, October 2026
Source: https://mcpx.fun/whitepaper

MCPX is a Solana-based platform connecting token creation with working software. Creators select an application template, configure a product and launch a token linked to an interactive web application and an MCP-compatible endpoint. Human users and compatible AI agents can access the same underlying capabilities under supported authentication and usage policies.

The problems it addresses are tokens without meaningful products, developers without distribution, fragmented application infrastructure and limited participation in the success of tools.

The proposed long-term vision is an open, reviewed marketplace: independent developers submit eligible applications; creators launch independently branded token-linked products using them; developers participate in eligible revenue attributable to adoption and usage. Community submissions and developer revenue sharing are future proposals, not represented as live functionality. Arbitrary unreviewed third-party code will not automatically execute. Review, permissions, isolation, versioning and lifecycle controls are required.

Potential developer revenue sources include eligible creator fees, paid execution, premium capabilities and future marketplace services. The developer share, funding source, settlement currency and payout timing are not yet established and must be defined in published terms and verifiable accounting rules before monetisation is activated.

The defined native $MCP creator-fee allocation model is 30% SOL allocations for eligible holders, 30% $MCP buybacks and token distributions, and 40% other allocations under the defined Treasury model. Accounting uses five-minute UTC windows and fees actually collected; allocations are not the same as confirmed onchain distributions. Child-token creator fees follow 60% creator, 25% operations and 15% platform. Proposed developer revenue must be reconciled with this framework without double-counting or inventing new implemented percentages.

Application categories include onchain intelligence, entertainment and experimental AI, AI Playground and future community applications spanning research, productivity, data, creativity, automation and developer services. The library is not restricted to blockchain analytics.

Trust requirements include verifiable token/product association, secure wallet authentication, controlled transactions, product credentials, usage limits, secure API keys, reliable accounting, monitoring and recovery, and clear distinctions between accrued, allocated and paid amounts.

Roadmap direction: establish token-powered applications; expand the library; introduce reviewed community submissions; enable developer attribution and revenue participation; improve discovery, reputation, analytics and integrations. These are directions, not guaranteed delivery dates. Economic parameters and operational availability require confirmation. This is not a claim of guaranteed returns or verified live payouts.

Please explain this proposed vision in plain language. Distinguish the described product foundation from future ambitions and unverified operational claims. Discuss the value for developers, creators, users and AI agents, the assumptions and risks, and the open questions around security, developer economics and execution costs. Do not invent token prices, returns, launch dates, developer percentages or live functionality. Use this summary as context, not as independent verification.`;

export function CopyVision() {
  const [state, setState] = useState<"idle" | "copied" | "manual">("idle");
  const pending = useRef(false);

  async function copy() {
    if (pending.current) return;
    pending.current = true;
    try {
      await navigator.clipboard.writeText(VISION_SUMMARY);
      setState("copied");
    } catch {
      setState("manual");
    } finally {
      pending.current = false;
    }
  }

  return (
    <div>
      <Button onClick={copy} size="lg" className="h-11 w-full px-5 sm:w-auto">
        {state === "copied" ? <Check aria-hidden /> : <Copy aria-hidden />}
        {state === "copied" ? "Summary copied" : "Copy summary for AI"}
      </Button>
      <p role="status" className="mt-3 text-xs leading-5 text-muted-foreground">
        {state === "copied" ? "Ready to paste into your preferred AI." : "Explore the vision with your preferred AI."}
      </p>
      {state === "manual" && (
        <div className="mt-4">
          <label htmlFor="vision-summary" className="mb-2 block text-sm text-foreground">Copy unavailable — select the summary below</label>
          <textarea id="vision-summary" readOnly value={VISION_SUMMARY} onFocus={(event) => event.currentTarget.select()} rows={8} className="w-full rounded-md border border-input bg-background p-3 text-sm leading-6 text-foreground" />
        </div>
      )}
    </div>
  );
}