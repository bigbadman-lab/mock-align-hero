// Runs the worker's real syncHolders step against the throwaway DB (/tmp/hpg) + Helius, read-only RPC.
// @ts-ignore
const { PGlite } = await import("/tmp/pgl/node_modules/@electric-sql/pglite/dist/index.js");
import { syncHolders } from "../src/holder-sync";
import { heliusRpc, type Meter } from "../src/helius-history";
const pg = new PGlite("/tmp/hpg/data"); const db = { query: async (t: string, p?: unknown[]) => ({ rows: (await pg.query(t, p ?? [])).rows as any[] }) };
const meter: Meter = {};
const r = await syncHolders(db, heliusRpc(`https://mainnet.helius-rpc.com/?api-key=${process.env.MCPX_HELIUS_TEST_API_KEY}`, meter), meter, "8M6WhZFXoEBr6iMc1DBapDoCHEF9RZnaUpk3Q3unpump", null);
const sum = (await db.query("select sum(amount)::text s from public.mcpx_rw_hix_balances")).rows[0].s;
console.log(JSON.stringify({ ...r, dbSum: sum, meter })); await pg.close();
