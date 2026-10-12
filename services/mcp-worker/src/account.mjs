// Account Checker v1 — one getAccountInfo read (base64, dataSlice 0/0 so no account data is fetched).
// "Owner" is the program allowed to modify the account's data, not the person who controls its funds.
import { RpcError, rpcFetch, parseAddress, formatUnits, PROGRAMS } from "./inspect.mjs";

export const AC_SCHEMA = "mcpx.tool-execution.account-checker.v1";
export const AC_TOOL_ID = "account_checker";
export const AC_COMMITMENT = "confirmed";
const SYSTEM = "11111111111111111111111111111111";
const LOADERS = new Set(["BPFLoaderUpgradeab1e11111111111111111111111", "BPFLoader2111111111111111111111111111111111", "BPFLoader1111111111111111111111111111111111", "LoaderV411111111111111111111111111111111111", "NativeLoader1111111111111111111111111111111"]);

export function classify(owner, executable) {
  if (executable) return "executable_program";
  if (owner === SYSTEM) return "system_owned";
  if (owner === PROGRAMS.splToken) return "spl_token_owned";
  if (owner === PROGRAMS.token2022) return "token_2022_owned";
  if (LOADERS.has(owner)) return "loader_owned";
  return "other_program_owned";
}

/** Exact lamports from raw JSON text (u64 can exceed 2^53). */
function lamportsFromText(text) {
  const m = /"lamports"\s*:\s*(\d{1,20})\s*[,}]/.exec(text);
  return m ? m[1].replace(/^0+(?=\d)/, "") : null;
}

export async function checkAccount({ address, rpcUrl, executionId, fetchImpl = fetch, signal, now = () => new Date() }) {
  const addr = parseAddress(address);
  if (!addr) throw new RpcError("invalid_input", "invalid address");
  const { result, rawText } = await rpcFetch(rpcUrl, "getAccountInfo", [addr, { commitment: AC_COMMITMENT, encoding: "base64", dataSlice: { offset: 0, length: 0 } }], fetchImpl, signal, true);
  if (!result || typeof result.context?.slot !== "number" || !("value" in result)) throw new RpcError("bad_response", "missing context");
  const base = { schema: AC_SCHEMA, executionId, toolId: AC_TOOL_ID, network: "solana-mainnet", commitment: AC_COMMITMENT, address: addr, fetchedAt: now().toISOString(), slot: result.context.slot };
  const v = result.value;
  if (v === null) return { ...base, exists: false, owner: null, executable: null, lamports: null, sol: null, space: null, classification: null };
  if (!v || typeof v !== "object" || !parseAddress(v.owner) || typeof v.executable !== "boolean") throw new RpcError("bad_response", "account shape");
  const lamports = lamportsFromText(rawText);
  if (lamports === null || (Number.isSafeInteger(v.lamports) && String(v.lamports) !== lamports)) throw new RpcError("bad_response", "lamports");
  const space = v.space === undefined ? null : Number.isSafeInteger(v.space) && v.space >= 0 ? v.space : undefined;
  if (space === undefined) throw new RpcError("bad_response", "space");
  return { ...base, exists: true, owner: v.owner, executable: v.executable, lamports, sol: formatUnits(lamports, 9), space, classification: classify(v.owner, v.executable) };
}
