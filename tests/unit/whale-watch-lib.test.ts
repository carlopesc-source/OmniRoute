// Unit tests for scripts/research/whale-watch (pure lib + fixture-driven sources).
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  DEFAULT_THRESHOLDS,
  aggregateHolders,
  alertKey,
  candidatesBySymbol,
  concentration,
  dedupeAlerts,
  detectChain,
  diffHolders,
  evaluateSignals,
  isPumpFunMint,
  normalizeMarket,
  pickBestPair,
  renderHtml,
  renderReport,
  resolveThresholds,
} from "../../scripts/research/whale-watch/lib.mjs";
import {
  dexPairsForMints,
  getLargestHolders,
  getMintInfo,
  getRugcheck,
  rpc,
} from "../../scripts/research/whale-watch/sources.mjs";

const MINT = "MintAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

function pair(over: Record<string, unknown> = {}) {
  return {
    chainId: "solana",
    dexId: "raydium",
    pairAddress: "PairAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    baseToken: { address: MINT, name: "Solrouter", symbol: "ROUTER" },
    quoteToken: { symbol: "SOL" },
    priceUsd: "0.0021",
    txns: {
      m5: { buys: 1, sells: 2 },
      h1: { buys: 10, sells: 30 },
      h6: { buys: 50, sells: 60 },
      h24: { buys: 100, sells: 90 },
    },
    volume: { m5: 100, h1: 1000, h6: 5000, h24: 20000 },
    priceChange: { m5: -1, h1: -25, h6: -10, h24: 19.5 },
    liquidity: { usd: 50000, base: 1, quote: 1 },
    fdv: 2000000,
    marketCap: 1481000,
    pairCreatedAt: 1_700_000_000_000,
    ...over,
  };
}

test("resolveThresholds merges only known numeric keys", () => {
  const t = resolveThresholds({ whaleSellPct: 33, bogus: 1, top10WarnPct: "x" } as never);
  assert.equal(t.whaleSellPct, 33);
  assert.equal(t.top10WarnPct, DEFAULT_THRESHOLDS.top10WarnPct);
  assert.equal("bogus" in t, false);
});

test("pickBestPair prefers the most liquid Solana pair for the mint", () => {
  const pairs = [
    pair({ chainId: "ethereum", liquidity: { usd: 1e9 } }),
    pair({ pairAddress: "low", liquidity: { usd: 100 } }),
    pair({ pairAddress: "high", liquidity: { usd: 90000 } }),
    pair({
      pairAddress: "other-mint",
      baseToken: { address: "X", symbol: "ROUTER" },
      liquidity: { usd: 1e7 },
    }),
  ];
  assert.equal(pickBestPair(pairs, { mint: MINT })?.pairAddress, "high");
  assert.equal(pickBestPair(pairs, { symbol: "router" })?.pairAddress, "other-mint");
  assert.equal(pickBestPair(null as never, { mint: MINT }), null);
});

test("candidatesBySymbol groups pairs by mint and sorts by liquidity", () => {
  const pairs = [
    pair({ liquidity: { usd: 1000 }, dexId: "raydium" }),
    pair({ liquidity: { usd: 2000 }, dexId: "orca", pairCreatedAt: 1_600_000_000_000 }),
    pair({ baseToken: { address: "X", symbol: "ROUTER", name: "Fake" }, liquidity: { usd: 5000 } }),
    pair({ baseToken: { address: "Y", symbol: "OTHER", name: "n" }, liquidity: { usd: 1e9 } }),
  ];
  const c = candidatesBySymbol(pairs, "ROUTER");
  assert.equal(c.length, 2);
  assert.equal(c[0].mint, "X");
  assert.equal(c[1].mint, MINT);
  assert.equal(c[1].liquidityUsd, 3000);
  assert.equal(c[1].pairs, 2);
  assert.deepEqual(c[1].dexIds, ["orca", "raydium"]);
  assert.equal(c[1].pairCreatedAt, 1_600_000_000_000);
});

test("normalizeMarket flattens a DexScreener pair and tolerates missing fields", () => {
  const m = normalizeMarket(pair());
  assert.equal(m.priceUsd, 0.0021);
  assert.equal(m.liquidityUsd, 50000);
  assert.deepEqual(m.txns.h1, { buys: 10, sells: 30 });
  const empty = normalizeMarket({ chainId: "solana" });
  assert.equal(empty.priceUsd, null);
  assert.equal(empty.liquidityUsd, null);
  assert.deepEqual(empty.txns.h24, { buys: 0, sells: 0 });
  assert.equal(normalizeMarket(null), null);
});

const ACCOUNTS = [
  { tokenAccount: "ta1", owner: "whale1", amount: 300 },
  { tokenAccount: "ta2", owner: "whale1", amount: 100 }, // same owner, two accounts
  { tokenAccount: "ta3", owner: "pool", amount: 500 },
  { tokenAccount: "ta4", owner: "whale2", amount: 150 },
  { tokenAccount: "ta5", owner: "whale3", amount: 50 },
  { tokenAccount: "ta6", owner: "zero", amount: 0 },
];

test("aggregateHolders merges accounts per owner, labels pools and computes pct", () => {
  const h = aggregateHolders(ACCOUNTS, {
    supply: 1000,
    poolAddresses: ["pool"],
    labels: { whale2: { name: "CEX hot", type: "exchange" } },
  });
  assert.deepEqual(
    h.map((x) => x.owner),
    ["pool", "whale1", "whale2", "whale3"]
  );
  assert.equal(h[1].amount, 400);
  assert.equal(h[1].pct, 40);
  assert.equal(h[0].isPool, true);
  assert.equal(h[2].label, "CEX hot");
  assert.equal(h[2].type, "exchange");
  const c = concentration(h);
  assert.equal(c.holdersConsidered, 3);
  assert.equal(c.top1Pct, 40);
  assert.equal(c.top10Pct, 60);
  assert.equal(c.poolPct, 50);
});

test("diffHolders classifies sells, exits, accumulation, new and departed whales", () => {
  const prev = aggregateHolders(ACCOUNTS, { supply: 1000, poolAddresses: ["pool"] });
  const curr = aggregateHolders(
    [
      { tokenAccount: "ta1", owner: "whale1", amount: 300 }, // 400 → 300 = -25% sell
      { tokenAccount: "ta3", owner: "pool", amount: 100 }, // pool ignored
      { tokenAccount: "ta4", owner: "whale2", amount: 5 }, // 150 → 5 = -96.7% exit
      { tokenAccount: "ta7", owner: "whale4", amount: 80 }, // new
      // whale3 gone from the list
    ],
    { supply: 1000, poolAddresses: ["pool"] }
  );
  const moves = diffHolders(prev, curr);
  assert.deepEqual(
    moves.map((m) => [m.kind, m.owner]),
    [
      ["WHALE_EXIT", "whale2"],
      ["WHALE_SELL", "whale1"],
      ["LEFT_TOP", "whale3"],
      ["NEW_WHALE", "whale4"],
    ]
  );
  assert.equal(moves[1].changePct, -25);
  // accumulation
  const up = aggregateHolders([{ tokenAccount: "ta1", owner: "whale1", amount: 600 }], {
    supply: 1000,
  });
  const upMoves = diffHolders(prev, up);
  assert.deepEqual(
    upMoves.find((m) => m.owner === "whale1"),
    { owner: "whale1", kind: "WHALE_ACCUMULATE", before: 400, after: 600, changePct: 50, pct: 60 }
  );
  assert.deepEqual(
    upMoves.filter((m) => m.kind === "LEFT_TOP").map((m) => m.owner),
    ["whale2", "whale3"]
  );
  // first run: no previous list → no NEW_WHALE noise
  assert.deepEqual(diffHolders([], curr), []);
});

test("evaluateSignals fires each rule with value + threshold and picks the level", () => {
  const holders = aggregateHolders(ACCOUNTS, { supply: 1000, poolAddresses: ["pool"] });
  const market = normalizeMarket(pair({ liquidity: { usd: 20000 }, marketCap: 1481000 }));
  const prevMarket = normalizeMarket(pair({ liquidity: { usd: 50000 } }));
  const r = evaluateSignals({
    holders,
    market,
    prevMarket,
    rug: {
      insiderPct: 12,
      lpLockedPct: 10,
      mintAuthority: "authX",
      freezeAuthority: null,
      risks: [
        { name: "Low Liquidity", level: "danger", description: "d" },
        { name: "x", level: "warn" },
      ],
    },
    moves: [{ owner: "whale2", kind: "WHALE_EXIT", before: 150, after: 5, changePct: -96.67 }],
    positionTokens: 15_600_000,
  });
  const ids = r.signals.map((s) => s.id);
  for (const id of [
    "TOP10_CONCENTRATION",
    "SINGLE_WHALE",
    "INSIDER_SHARE",
    "LP_UNLOCKED",
    "MINT_AUTHORITY",
    "RUGCHECK:Low Liquidity",
    "WHALE_EXIT",
    "LIQUIDITY_DROP",
    "PRICE_DROP_1H",
    "SELL_PRESSURE_1H",
    "THIN_LIQUIDITY",
    "POSITION_VS_LIQUIDITY",
  ]) {
    assert.ok(ids.includes(id), `missing ${id}`);
  }
  assert.ok(!ids.includes("FREEZE_AUTHORITY"));
  assert.ok(!ids.includes("PRICE_DROP_24H"));
  assert.ok(!ids.includes("RUGCHECK:x"));
  assert.equal(r.level, "PELIGRO");
  const liq = r.signals.find((s) => s.id === "LIQUIDITY_DROP");
  assert.equal(liq.value, -60);
  assert.equal(liq.threshold, -25);
  const pos = r.signals.find((s) => s.id === "POSITION_VS_LIQUIDITY");
  assert.equal(pos.value, 163.8); // 15.6M * 0.0021 = $32,760 vs $20,000 pool
  assert.ok(r.score >= 12);
});

test("evaluateSignals returns SIN DATOS with no data and ATENCION on warn-only", () => {
  assert.equal(evaluateSignals({}).level, "SIN DATOS");
  const r = evaluateSignals({
    market: normalizeMarket(
      pair({ priceChange: { h1: -21 }, txns: {}, liquidity: { usd: 1e6 }, marketCap: 1e6 })
    ),
  });
  assert.equal(r.level, "ATENCION");
  assert.deepEqual(
    r.signals.map((s) => s.id),
    ["PRICE_DROP_1H"]
  );
});

test("dedupeAlerts suppresses repeats inside the cooldown and keys by rounded value", () => {
  const sig = { id: "WHALE_SELL", severity: "WARN", value: -25.4, threshold: -20, detail: "" };
  assert.equal(alertKey("ROUTER", sig), "ROUTER|WHALE_SELL|-25");
  const [a, st1] = dedupeAlerts("ROUTER", [sig], {}, 1000, 100);
  assert.equal(a.length, 1);
  const [b] = dedupeAlerts("ROUTER", [sig], st1, 1050, 100);
  assert.equal(b.length, 0);
  const [c] = dedupeAlerts("ROUTER", [sig], st1, 1200, 100);
  assert.equal(c.length, 1);
});

test("renderReport produces the summary table, per-token sections and error rows", () => {
  const holders = aggregateHolders(ACCOUNTS, { supply: 1000, poolAddresses: ["pool"] });
  const market = normalizeMarket(pair());
  const evaluation = evaluateSignals({ holders, market });
  const md = renderReport(
    [
      {
        symbol: "ROUTER",
        mint: MINT,
        market,
        holders,
        evaluation,
        moves: [{ kind: "WHALE_SELL", owner: "whale1", before: 400, after: 300, changePct: -25 }],
        rug: { score: 1, insiderPct: 2, lpLockedPct: 100 },
      },
      {
        symbol: "DOT",
        mint: null,
        error: "boom",
        evaluation: { level: "ERROR", signals: [], concentration: {} },
      },
    ],
    { generatedAt: new Date(0) }
  );
  assert.match(
    md,
    /\| ROUTER \| PELIGRO \| \$0\.002100 \| \$50\.0K \| \$1\.48M \| 3\.38% \| -25% \| \+19\.5% \| 60% \| TOP10_CONCENTRATION, SINGLE_WHALE, PRICE_DROP_1H, SELL_PRESSURE_1H \|/
  );
  assert.match(md, /## DOT \(mint sin resolver\) — ERROR/);
  assert.match(md, /- ERROR: boom/);
  assert.match(md, /WHALE_SELL whale1: 400 → 300 \(-25%\)/);
  assert.match(md, /\| 1 \| pool \| pool \| 500 \| 50% \|/);
  assert.match(md, /no son predicciones/);
});

// ---------------- sources with injected fetch ----------------
test("rpc + getMintInfo + getLargestHolders parse JSON-RPC payloads", async () => {
  const calls: Array<{ url: string; body: { method: string; params: unknown[] } }> = [];
  const fetchJson = async (url: string, init: { body?: string } = {}) => {
    const body = JSON.parse(init.body || "{}");
    calls.push({ url, body });
    switch (body.method) {
      case "getAccountInfo":
        return {
          result: {
            value: {
              owner: "TokenkegQ",
              data: {
                parsed: {
                  info: {
                    decimals: 6,
                    supply: "1000000000000",
                    mintAuthority: null,
                    freezeAuthority: "FRZ",
                  },
                },
              },
            },
          },
        };
      case "getTokenLargestAccounts":
        return {
          result: {
            value: [
              { address: "ta1", amount: "500000000", decimals: 6, uiAmount: 500 },
              { address: "ta2", amount: "100000000", decimals: 6, uiAmount: null },
            ],
          },
        };
      case "getMultipleAccounts":
        return { result: { value: [{ data: { parsed: { info: { owner: "whale1" } } } }, null] } };
      case "boom":
        return { error: { message: "nope" } };
      default:
        throw new Error("unexpected " + body.method);
    }
  };
  const info = await getMintInfo("http://rpc", MINT, fetchJson as never);
  assert.deepEqual(info, {
    decimals: 6,
    supply: 1_000_000,
    mintAuthority: null,
    freezeAuthority: "FRZ",
    program: "TokenkegQ",
  });
  const holders = await getLargestHolders("http://rpc", MINT, 6, fetchJson as never);
  assert.deepEqual(holders, [{ tokenAccount: "ta1", amount: 500, owner: "whale1" }]); // ta2 dropped: owner unknown
  await assert.rejects(() => rpc("http://rpc", "boom", [], fetchJson as never), /RPC boom: nope/);
  assert.equal(calls[0].body.params[1].encoding, "jsonParsed");
});

test("getRugcheck flattens holders, insiders, LP lock, pools and known accounts", async () => {
  const fetchJson = async () => ({
    score: 1234,
    score_normalised: 42,
    totalHolders: 900,
    token: { mintAuthority: null, freezeAuthority: null },
    topHolders: [
      { address: "ta1", owner: "whale1", pct: 12.5, uiAmount: 125, insider: true },
      { address: "ta2", owner: "whale2", pct: 5, uiAmount: 50, insider: false },
      { address: "ta3", owner: "whale3", pct: 3.25, uiAmount: 32, insider: true },
    ],
    markets: [
      {
        pubkey: "poolA",
        marketType: "raydium_v4",
        liquidityA: "vaultA",
        liquidityB: "vaultB",
        liquidityAAccount: { owner: "rayAuth" },
        lp: { lpLockedPct: 99.9 },
      },
      { pubkey: "poolB", marketType: "pump_amm", lp: { lpLockedPct: 10 } },
    ],
    knownAccounts: {
      rayAuth: { name: "Raydium Authority", type: "AMM" },
      cex1: { name: "Binance 1", type: "Exchange" },
      dev: { name: "Creator", type: "Creator" },
    },
    risks: [
      {
        name: "Top 10 holders high ownership",
        level: "warn",
        value: "40%",
        description: "x",
        score: 100,
      },
    ],
    insiderNetworks: [{ id: "n1", size: 7, tokenAmount: 1 }],
  });
  const r = await getRugcheck(MINT, fetchJson as never);
  assert.equal(r.scoreNormalised, 42);
  assert.equal(r.insiderPct, 15.75);
  assert.equal(r.lpLockedPct, 99.9);
  assert.deepEqual(r.poolTokenAccounts, ["vaultA", "vaultB"]);
  assert.deepEqual(r.poolOwners.sort(), ["poolA", "poolB", "rayAuth"]);
  assert.deepEqual(r.labels.rayAuth, { name: "Raydium Authority", type: "pool" });
  assert.equal(r.labels.cex1.type, "exchange");
  assert.equal(r.labels.dev.type, "insider");
  assert.equal(r.risks[0].level, "warn");
  assert.equal(r.topHolders[0].insider, true);
  // empty payload does not crash
  const empty = await getRugcheck(MINT, (async () => ({})) as never);
  assert.equal(empty.lpLockedPct, null);
  assert.equal(empty.insiderPct, 0);
});

test("dexPairsForMints falls back to the per-token endpoint when the batch endpoint fails", async () => {
  const urls: string[] = [];
  const fetchJson = async (url: string) => {
    urls.push(url);
    if (url.includes("/tokens/v1/")) throw new Error("HTTP 404");
    return { pairs: [pair()] };
  };
  const pairs = await dexPairsForMints([MINT, "M2"], fetchJson as never);
  assert.equal(pairs.length, 2);
  assert.equal(urls.length, 3);
  assert.match(urls[1], /\/latest\/dex\/tokens\//);
  const batch = await dexPairsForMints([MINT], (async () => [pair(), pair()]) as never);
  assert.equal(batch.length, 2);
});

test("renderHtml converts headings, tables, lists and flags danger rows", () => {
  const md =
    "# T\n\n| Token | Nivel |\n|---|---|\n| A | PELIGRO |\n| B | OK |\n\n## S\n- x <y>\n_nota_\n";
  const html = renderHtml(md, { title: "R <1>" });
  assert.match(html, /<title>R &lt;1&gt;<\/title>/);
  assert.match(html, /<h1>T<\/h1>/);
  assert.match(html, /<tr class="danger"><td>A<\/td><td>PELIGRO<\/td><\/tr>/);
  assert.match(html, /<tr><td>B<\/td><td>OK<\/td><\/tr>/);
  assert.match(html, /<li>x &lt;y&gt;<\/li>/);
  assert.match(html, /<p><em>nota<\/em><\/p>/);
});

test("detectChain separates Solana base58 mints from EVM 0x addresses", () => {
  assert.equal(detectChain("6SjVTj1VGwFSXn7wEjwFm77LvACeTqB7sQUebYKX8Ds5"), "solana");
  assert.equal(detectChain("pC9Wo6oHLJx2Vwrvrtpj64mRHQPFYwvGSr4eR2apump"), "solana");
  assert.equal(detectChain("0x23a2847d772803f9efc64b4277b782b06296fe51"), "evm");
  assert.equal(detectChain("0xC52AEDEC3374422D7510E294CFAA90799595CBA3"), "evm");
  assert.equal(detectChain("0x1234"), "unknown"); // too short for EVM
  assert.equal(detectChain("0OIl+/=="), "unknown"); // base58 excludes 0 O I l
  assert.equal(detectChain(null as never), "unknown");
});

test("pickBestPair on an EVM token ignores Solana pairs and matches case-insensitively", () => {
  const evm = "0x23a2847d772803f9efc64b4277b782b06296fe51";
  const pairs = [
    { chainId: "solana", baseToken: { address: evm }, liquidity: { usd: 1e9 } },
    {
      chainId: "base",
      pairAddress: "base-pair",
      baseToken: { address: evm.toUpperCase() },
      liquidity: { usd: 5000 },
    },
    {
      chainId: "ethereum",
      pairAddress: "eth-pair",
      baseToken: { address: evm },
      liquidity: { usd: 90000 },
    },
  ];
  assert.equal(pickBestPair(pairs, { mint: evm, chain: "evm" })?.pairAddress, "eth-pair");
  assert.equal(pickBestPair(pairs, { mint: evm, chain: "solana" })?.chainId, "solana");
});

test("evaluateSignals reports SIN DATOS instead of OK when nothing was observed", () => {
  assert.equal(evaluateSignals({}).level, "SIN DATOS");
  assert.equal(
    evaluateSignals({ holders: [], market: null, rug: {}, moves: [] }).level,
    "SIN DATOS"
  );
  // Market data present and every rule quiet => genuinely OK.
  const calm = normalizeMarket({
    chainId: "ethereum",
    baseToken: { address: "0x1" },
    priceUsd: "1",
    liquidity: { usd: 500000 },
    marketCap: 1000000,
    priceChange: { h1: 1, h24: 2 },
    txns: { h1: { buys: 50, sells: 10 } },
  });
  assert.equal(evaluateSignals({ holders: [], market: calm, rug: {}, moves: [] }).level, "OK");
});

test("isPumpFunMint detects the pump.fun vanity suffix on Solana mints only", () => {
  assert.equal(isPumpFunMint("69LjZUUzxj3Cb3Fxeo1X4QpYEQTboApkhXTysPpbpump"), true);
  assert.equal(isPumpFunMint("pC9Wo6oHLJx2Vwrvrtpj64mRHQPFYwvGSr4eR2apump"), true);
  assert.equal(isPumpFunMint("6SjVTj1VGwFSXn7wEjwFm77LvACeTqB7sQUebYKX8Ds5"), false);
  assert.equal(isPumpFunMint("0xb5761f36fdfe2892f1b54bc8ee8babb2a1b698d3"), false);
  assert.equal(isPumpFunMint(null as never), false);
});

test("entry-side guards fire on the way up and on a fresh pair", () => {
  const hot = normalizeMarket({
    chainId: "solana",
    baseToken: { address: "M" },
    priceUsd: "1",
    liquidity: { usd: 500000 },
    marketCap: 1000000,
    priceChange: { h1: 60, h24: 250 },
    txns: { h1: { buys: 80, sells: 10 } },
    pairCreatedAt: Date.now() - 2 * 86400000,
  });
  const r = evaluateSignals({ holders: [], market: hot, rug: {}, moves: [], isPumpFun: true });
  const ids = r.signals.map((s) => s.id);
  assert.ok(ids.includes("FOMO_RISK_1H"));
  assert.ok(ids.includes("FOMO_RISK_24H"));
  assert.ok(ids.includes("RECENT_LAUNCH"));
  assert.ok(ids.includes("PUMP_FUN_ORIGIN"));
  assert.equal(r.signals.find((s) => s.id === "RECENT_LAUNCH").value, 2);
  assert.equal(r.level, "ATENCION");

  // An old pair rising gently trips none of them.
  const calm = normalizeMarket({
    chainId: "solana",
    baseToken: { address: "M" },
    priceUsd: "1",
    liquidity: { usd: 500000 },
    marketCap: 1000000,
    priceChange: { h1: 3, h24: 8 },
    txns: { h1: { buys: 80, sells: 10 } },
    pairCreatedAt: Date.now() - 400 * 86400000,
  });
  assert.deepEqual(evaluateSignals({ holders: [], market: calm, rug: {}, moves: [] }).signals, []);
});
