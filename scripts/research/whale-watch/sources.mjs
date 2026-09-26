// Data sources for scripts/research/whale-watch. Every function takes an
// optional `fetchJson` so tests can inject fixtures; the default uses global
// fetch with a timeout and a small retry.
//
// Public endpoints used (no API key):
//   - DexScreener  https://api.dexscreener.com   (pairs, price, liquidity, txns)
//   - Solana RPC   https://api.mainnet-beta.solana.com (supply, 20 largest token accounts, owners)
//                  `rpc()` accepts ONE url or a LIST: it retries 429/5xx with backoff and moves to
//                  the next url on 401/403/"needs a key" answers (public endpoints differ a lot).
//   - RugCheck     https://api.rugcheck.xyz/v1   (top holders, insiders, LP lock, risks)
// Optional (API key): Helius `getTokenAccounts` for the FULL holder list.

const UA = "omniroute-whale-watch/0.1 (+scripts/research/whale-watch)";

export async function defaultFetchJson(url, init = {}, { timeoutMs = 20000, retries = 2 } = {}) {
  let lastErr;
  for (let i = 0; i <= retries; i++) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        ...init,
        signal: ctl.signal,
        headers: { accept: "application/json", "user-agent": UA, ...(init.headers || {}) },
      });
      if (res.status === 429 || res.status >= 500) {
        lastErr = new Error(`HTTP ${res.status} ${url}`);
        await sleep(500 * 2 ** i);
        continue;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
      return await res.json();
    } catch (err) {
      lastErr = err;
      if (err?.name === "AbortError") await sleep(300 * 2 ** i);
      else if (!/HTTP (429|5\d\d)/.test(String(err?.message))) throw err;
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr;
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------- DexScreener ----------------
export async function dexSearch(query, fetchJson = defaultFetchJson) {
  const data = await fetchJson(
    `https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(query)}`
  );
  return Array.isArray(data?.pairs) ? data.pairs : [];
}

const EVM_ADDR = /^0x[0-9a-fA-F]{40}$/;

/**
 * DexScreener pairs for a list of token addresses.
 * - Solana mints go through the chain-scoped batch endpoint `/tokens/v1/solana/{a,b,c}`.
 * - EVM addresses (0x…) go through the chain-agnostic `/latest/dex/tokens/{a,b,c}`: the
 *   config does not know WHICH EVM chain a token lives on (Robinhood Chain, Base, Ethereum…),
 *   and that endpoint returns the pairs on every chain so `pickBestPair` can choose.
 *   Sending 0x addresses to `/tokens/v1/solana/` returns nothing, which is why EVM tokens
 *   used to show `price=n/d`.
 * Any batch failure falls back to one request per address on the chain-agnostic endpoint.
 */
export async function dexPairsForMints(mints, fetchJson = defaultFetchJson) {
  const out = [];
  const solana = mints.filter((m) => !EVM_ADDR.test(m));
  const evm = mints.filter((m) => EVM_ADDR.test(m));
  const perToken = async (chunk) => {
    const pairs = [];
    for (const m of chunk) {
      const d = await fetchJson(`https://api.dexscreener.com/latest/dex/tokens/${m}`);
      if (Array.isArray(d?.pairs)) pairs.push(...d.pairs);
    }
    return pairs;
  };
  const asPairs = (data) =>
    Array.isArray(data) ? data : Array.isArray(data?.pairs) ? data.pairs : null;
  for (let i = 0; i < solana.length; i += 30) {
    const chunk = solana.slice(i, i + 30);
    let pairs = null;
    try {
      pairs = asPairs(
        await fetchJson(`https://api.dexscreener.com/tokens/v1/solana/${chunk.join(",")}`)
      );
    } catch {
      pairs = null;
    }
    out.push(...(pairs || (await perToken(chunk))));
  }
  for (let i = 0; i < evm.length; i += 30) {
    const chunk = evm.slice(i, i + 30);
    let pairs = null;
    try {
      pairs = asPairs(
        await fetchJson(`https://api.dexscreener.com/latest/dex/tokens/${chunk.join(",")}`)
      );
    } catch {
      pairs = null;
    }
    out.push(...(pairs || (await perToken(chunk))));
  }
  return out;
}

// ---------------- Solana JSON-RPC ----------------
/** Answers that mean "this endpoint will not serve this call": try the next url. */
const RPC_SKIP_ENDPOINT =
  /HTTP (401|403|404)\b|api key|personal token|not allowed|upgrade|free plan/i;
/** Answers that mean "slow down": retry the same url with backoff. */
const RPC_RETRY =
  /HTTP (429|5\d\d)\b|too many requests|rate limit|Internal JSON-RPC error|timeout|AbortError/i;

/**
 * JSON-RPC call against one url or an ordered list of urls.
 * Per url: up to `attempts` tries with exponential backoff on 429/5xx-style answers.
 * On 401/403/"needs a key" answers the url is skipped and the next one is tried.
 * Deterministic RPC errors (bad params, mint not found) are thrown at once: no url will fix them.
 */
export async function rpc(
  rpcUrl,
  method,
  params,
  fetchJson = defaultFetchJson,
  { attempts = 4, baseDelayMs = 1000 } = {}
) {
  const urls = (Array.isArray(rpcUrl) ? rpcUrl : [rpcUrl]).filter(Boolean);
  if (!urls.length) throw new Error(`RPC ${method}: no rpc url configured`);
  const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method, params });
  let lastErr;
  for (const url of urls) {
    for (let i = 0; i < attempts; i++) {
      let data;
      try {
        // retries: 0 → this loop owns backoff and endpoint rotation.
        data = await fetchJson(
          url,
          { method: "POST", headers: { "content-type": "application/json" }, body },
          { retries: 0 }
        );
      } catch (err) {
        lastErr = new Error(`RPC ${method}: ${err?.message || err} (${url})`);
        if (RPC_SKIP_ENDPOINT.test(String(err?.message))) break; // next url
        if (RPC_RETRY.test(String(err?.message)) || err?.name === "AbortError") {
          await sleep(baseDelayMs * 2 ** i);
          continue;
        }
        throw lastErr;
      }
      if (data?.error) {
        const msg = data.error.message || JSON.stringify(data.error);
        lastErr = new Error(`RPC ${method}: ${msg} (${url})`);
        if (RPC_SKIP_ENDPOINT.test(msg)) break; // next url
        if (RPC_RETRY.test(msg) || data.error.code === 429) {
          await sleep(baseDelayMs * 2 ** i);
          continue;
        }
        throw lastErr; // deterministic error, e.g. "could not find mint"
      }
      return data?.result;
    }
  }
  throw lastErr || new Error(`RPC ${method}: all endpoints failed`);
}

export async function getMintInfo(rpcUrl, mint, fetchJson) {
  const r = await rpc(rpcUrl, "getAccountInfo", [mint, { encoding: "jsonParsed" }], fetchJson);
  const info = r?.value?.data?.parsed?.info || null;
  if (!info) throw new Error(`mint ${mint}: account not found or not a token mint`);
  const decimals = Number(info.decimals);
  return {
    decimals,
    supply: Number(info.supply) / 10 ** decimals,
    mintAuthority: info.mintAuthority || null,
    freezeAuthority: info.freezeAuthority || null,
    program: r?.value?.owner || null,
  };
}

/** 20 largest token accounts (RPC hard limit) resolved to their owners. */
export async function getLargestHolders(rpcUrl, mint, decimals, fetchJson) {
  const r = await rpc(rpcUrl, "getTokenLargestAccounts", [mint], fetchJson);
  const list = (r?.value || []).map((a) => ({
    tokenAccount: a.address,
    amount: a.uiAmount != null ? Number(a.uiAmount) : Number(a.amount) / 10 ** decimals,
  }));
  if (!list.length) return [];
  const owners = await rpc(
    rpcUrl,
    "getMultipleAccounts",
    [list.map((a) => a.tokenAccount), { encoding: "jsonParsed" }],
    fetchJson
  );
  (owners?.value || []).forEach((acc, i) => {
    list[i].owner = acc?.data?.parsed?.info?.owner || null;
  });
  return list.filter((a) => a.owner);
}

/** Full holder list through Helius DAS `getTokenAccounts` (needs HELIUS_API_KEY). */
export async function getAllHoldersHelius(
  heliusUrl,
  mint,
  decimals,
  fetchJson,
  { maxPages = 50 } = {}
) {
  const out = [];
  let cursor;
  for (let page = 0; page < maxPages; page++) {
    const params = { mint, limit: 1000, ...(cursor ? { cursor } : {}) };
    const r = await rpc(heliusUrl, "getTokenAccounts", params, fetchJson);
    for (const a of r?.token_accounts || []) {
      out.push({
        tokenAccount: a.address,
        owner: a.owner,
        amount: Number(a.amount) / 10 ** decimals,
      });
    }
    cursor = r?.cursor;
    if (!cursor || !(r?.token_accounts || []).length) break;
  }
  return out;
}

// ---------------- RugCheck ----------------
/**
 * Fetch and flatten the RugCheck report. Field names follow RugCheck's public
 * `/v1/tokens/{mint}/report` payload; every access is optional so a missing or
 * renamed field degrades to null instead of crashing the run.
 */
export async function getRugcheck(mint, fetchJson = defaultFetchJson) {
  const r = await fetchJson(`https://api.rugcheck.xyz/v1/tokens/${mint}/report`);
  const top = Array.isArray(r?.topHolders) ? r.topHolders : [];
  const insiderPct = top.filter((h) => h?.insider).reduce((s, h) => s + (Number(h.pct) || 0), 0);
  const markets = Array.isArray(r?.markets) ? r.markets : [];
  const lpLocked = markets.map((m) => Number(m?.lp?.lpLockedPct)).filter((v) => Number.isFinite(v));
  const poolTokenAccounts = new Set();
  const poolOwners = new Set();
  for (const m of markets) {
    for (const k of ["liquidityA", "liquidityB"])
      if (typeof m?.[k] === "string") poolTokenAccounts.add(m[k]);
    for (const k of ["liquidityAAccount", "liquidityBAccount"])
      if (m?.[k]?.owner) poolOwners.add(m[k].owner);
    if (typeof m?.pubkey === "string") poolOwners.add(m.pubkey);
  }
  const labels = {};
  for (const [addr, k] of Object.entries(r?.knownAccounts || {})) {
    if (!k) continue;
    labels[addr] = { name: k.name || k.type || "known", type: normaliseType(k.type) };
  }
  const decimals = Number.isFinite(Number(r?.token?.decimals)) ? Number(r.token.decimals) : null;
  const rawSupply = Number(r?.token?.supply);
  return {
    score: r?.score ?? null,
    scoreNormalised: r?.score_normalised ?? null,
    decimals,
    supply: decimals != null && Number.isFinite(rawSupply) ? rawSupply / 10 ** decimals : null,
    insiderPct,
    insiderNetworks: (r?.insiderNetworks || []).map((n) => ({
      id: n?.id,
      size: n?.size,
      tokenAmount: n?.tokenAmount,
    })),
    lpLockedPct: lpLocked.length ? Math.max(...lpLocked) : null,
    totalMarketLiquidity: r?.totalMarketLiquidity ?? null,
    totalHolders: r?.totalHolders ?? null,
    mintAuthority: r?.token?.mintAuthority || r?.mintAuthority || null,
    freezeAuthority: r?.token?.freezeAuthority || r?.freezeAuthority || null,
    risks: (r?.risks || []).map((x) => ({
      name: x?.name,
      level: x?.level,
      value: x?.value,
      description: x?.description,
      score: x?.score,
    })),
    topHolders: top.map((h) => ({
      owner: h?.owner || h?.address,
      tokenAccount: h?.address,
      pct: Number(h?.pct) || 0,
      amount: Number(h?.uiAmount) || 0,
      insider: !!h?.insider,
    })),
    poolTokenAccounts: [...poolTokenAccounts],
    poolOwners: [...poolOwners],
    labels,
  };
}

function normaliseType(t) {
  const s = String(t || "").toLowerCase();
  if (/amm|pool|raydium|orca|meteora|pump|lp|market|vault/.test(s)) return "pool";
  if (/burn|incinerat/.test(s)) return "burn";
  if (/exchange|cex|binance|bybit|okx|kucoin|coinbase|gate/.test(s)) return "exchange";
  if (/creator|dev|team|insider/.test(s)) return "insider";
  return s || "known";
}

// ---------------- Alert channels ----------------
export async function sendTelegram(text, { token, chatId }, fetchJson = defaultFetchJson) {
  return fetchJson(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
  });
}

export async function sendDiscord(text, { webhookUrl }) {
  const res = await fetch(webhookUrl, {
    method: "POST",
    headers: { "content-type": "application/json", "user-agent": UA },
    body: JSON.stringify({ content: text.slice(0, 1900) }),
  });
  if (!res.ok) throw new Error(`discord webhook HTTP ${res.status}`);
  return true;
}

// ---------------- CoinGecko (public API, no key required; optional demo key) ----------------
const CG = "https://api.coingecko.com/api/v3";
function cgHeaders() {
  const key = process.env.COINGECKO_API_KEY;
  return key ? { "x-cg-demo-api-key": key } : {};
}

/** All category ids (for `--category`). Filter client-side with `q`. */
export async function cgCategories(q = "", fetchJson = defaultFetchJson) {
  const list = await fetchJson(`${CG}/coins/categories/list`, { headers: cgHeaders() });
  const needle = q.toLowerCase();
  return (Array.isArray(list) ? list : []).filter(
    (c) => !needle || `${c.category_id} ${c.name}`.toLowerCase().includes(needle)
  );
}

/** Market rows for a category or an explicit id list (max 250 per call). */
export async function cgMarkets({ category = null, ids = [] } = {}, fetchJson = defaultFetchJson) {
  const params = new URLSearchParams({
    vs_currency: "usd",
    order: "market_cap_desc",
    per_page: "250",
    page: "1",
    price_change_percentage: "24h,7d,30d",
  });
  if (category) params.set("category", category);
  if (ids.length) params.set("ids", ids.join(","));
  const rows = await fetchJson(`${CG}/coins/markets?${params}`, { headers: cgHeaders() });
  return Array.isArray(rows) ? rows : [];
}

/** Resolve a name/symbol to CoinGecko ids. */
export async function cgSearch(query, fetchJson = defaultFetchJson) {
  const r = await fetchJson(`${CG}/search?query=${encodeURIComponent(query)}`, {
    headers: cgHeaders(),
  });
  return (r?.coins || []).map((c) => ({
    id: c.id,
    name: c.name,
    symbol: c.symbol,
    rank: c.market_cap_rank ?? null,
  }));
}
