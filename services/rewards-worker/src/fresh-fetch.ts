// Site requests on a brand-new connection each time. Observed on Render: after the first pass every request to the
// site hung until its timeout and never reached the site (pooled keep-alive sockets going stale). agent:false means
// no pooling, so one dead socket can't stall the worker.
import https from "node:https";

export const freshFetch = ((url: string, init: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal }) =>
  new Promise<Response>((resolve, reject) => {
    const req = https.request(url, { method: init.method ?? "GET", headers: { ...init.headers, connection: "close" }, agent: false, signal: init.signal }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => resolve(new Response(Buffer.concat(chunks), { status: res.statusCode ?? 0 })));
      res.on("error", reject);
    });
    req.on("error", reject);
    if (init.body) req.write(init.body);
    req.end();
  })) as unknown as typeof fetch;
