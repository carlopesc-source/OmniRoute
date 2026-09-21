// Pure, side-effect-free helpers for scripts/research/whale-watch.
// Everything here is deterministic and unit-tested (tests/unit/whale-watch-lib.test.ts).
// No network, no filesystem: the CLI (whale-watch.mjs) and the data sources
// (sources.mjs) call into this module.

export const DEFAULT_THRESHOLDS = Object.freeze({
  // Holder concentration (share of circulating supply, %; pools/LP excluded).
  top10WarnPct: 30,
  top10DangerPct: 50,
  singleWhaleWarnPct: 10,
  // RugCheck insider-flagged share of supply (%).
  insiderWarnPct: 10,
  // Liquidity locked (% of LP) below which the pool is considered unlocked.
  lpLockedMinPct: 50,
  // Whale movements between two snapshots (% of the whale's previous balance).
  whaleSellPct: 20,
  whaleExitPct: 90,
  whaleAccumulatePct: 20,
  // Market moves between two snapshots / DexScreener windows.
  liquidityDropPct: 25,
  priceDrop1hPct: -20,
  priceDrop24hPct: -40,
  sellBuyRatioWarn: 1.5,
  minTxnsForRatio: 20,
  // Liquidity depth.
  liqToMcapMinPct: 2,
  positionToLiqWarnPct: 10,
  // Entry-side guards (the inverse of a sell signal: when NOT to buy on impulse).
  fomoPump1hPct: 50,
  fomoPump24hPct: 200,
  recentLaunchDays: 7,
});

const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const EVM = /^0x[0-9a-fA-F]{40}$/;

/**
 * Chain family inferred from the address FORMAT alone.
 * "solana" = base58 32-44 chars; "evm" = 0x + 40 hex (Ethereum, Base, BSC, Arbitrum…
 * the format does NOT say which of them, only DexScreener does); "unknown" otherwise.
 */
export function detectChain(address) {
  if (typeof address !== "string") return "unknown";
  if (EVM.test(address)) return "evm";
  if (BASE58.test(address)) return "solana";
  return "unknown";
}

/**
 * True when the mint address ends in "pump", the suffix produced by pump.fun's
 * vanity mint generator. This identifies the LAUNCH VENUE only. It says nothing
 * about whether a project, team or product exists behind the token.
 */
export function isPumpFunMint(address) {
  return (
    typeof address === "string" && detectChain(address) === "solana" && address.endsWith("pump")
  );
}

export const LEVELS = Object.freeze({
  OK: "OK",
  WARN: "ATENCION",
  DANGER: "PELIGRO",
  NODATA: "SIN DATOS",
});

/** Merge user thresholds over defaults, ignoring unknown/invalid keys. */
export function resolveThresholds(user = {}) {
  const out = { ...DEFAULT_THRESHOLDS };
  for (const [k, v] of Object.entries(user || {})) {
    if (k in DEFAULT_THRESHOLDS && typeof v === "number" && Number.isFinite(v)) out[k] = v;
  }
  return out;
}

/**
 * Pick the most liquid Solana pair for a token from a DexScreener `pairs` array.
 * When `mint` is given only pairs whose baseToken.address matches are considered.
 */
export function pickBestPair(pairs, { mint = null, symbol = null, chain = "solana" } = {}) {
  if (!Array.isArray(pairs)) return null;
  const candidates = pairs.filter((p) => {
    if (!p) return false;
    // EVM addresses live on many chains; the most liquid pair decides which one.
    if (chain === "solana" && p.chainId !== "solana") return false;
    if (chain === "evm" && p.chainId === "solana") return false;
    if (mint) return (p.baseToken?.address || "").toLowerCase() === mint.toLowerCase();
    if (symbol) return (p.baseToken?.symbol || "").toUpperCase() === symbol.toUpperCase();
    return true;
  });
  candidates.sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0));
  return candidates[0] || null;
}

/** Group DexScreener pairs by base mint so `resolve` can show every candidate for a symbol. */
export function candidatesBySymbol(pairs, symbol) {
  const byMint = new Map();
  for (const p of pairs || []) {
    if (p?.chainId !== "solana") continue;
    if ((p.baseToken?.symbol || "").toUpperCase() !== symbol.toUpperCase()) continue;
    const mint = p.baseToken.address;
    const cur = byMint.get(mint) || {
      mint,
      name: p.baseToken.name,
      symbol: p.baseToken.symbol,
      liquidityUsd: 0,
      volume24hUsd: 0,
      pairs: 0,
      dexIds: new Set(),
      pairCreatedAt: p.pairCreatedAt || null,
    };
    cur.liquidityUsd += p.liquidity?.usd || 0;
    cur.volume24hUsd += p.volume?.h24 || 0;
    cur.pairs += 1;
    cur.dexIds.add(p.dexId);
    if (p.pairCreatedAt && (!cur.pairCreatedAt || p.pairCreatedAt < cur.pairCreatedAt)) {
      cur.pairCreatedAt = p.pairCreatedAt;
    }
    byMint.set(mint, cur);
  }
  return [...byMint.values()]
    .map((c) => ({ ...c, dexIds: [...c.dexIds].sort() }))
    .sort((a, b) => b.liquidityUsd - a.liquidityUsd);
}

/** Normalise a DexScreener pair into the flat market record stored in snapshots. */
export function normalizeMarket(pair) {
  if (!pair) return null;
  const n = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  const tx = (w) => ({
    buys: n(pair.txns?.[w]?.buys) ?? 0,
    sells: n(pair.txns?.[w]?.sells) ?? 0,
  });
  return {
    pairAddress: pair.pairAddress || null,
    dexId: pair.dexId || null,
    quoteSymbol: pair.quoteToken?.symbol || null,
    priceUsd: pair.priceUsd != null ? Number(pair.priceUsd) : null,
    liquidityUsd: n(pair.liquidity?.usd),
    fdvUsd: n(pair.fdv),
    marketCapUsd: n(pair.marketCap),
    volume: {
      m5: n(pair.volume?.m5),
      h1: n(pair.volume?.h1),
      h6: n(pair.volume?.h6),
      h24: n(pair.volume?.h24),
    },
    priceChange: {
      m5: n(pair.priceChange?.m5),
      h1: n(pair.priceChange?.h1),
      h6: n(pair.priceChange?.h6),
      h24: n(pair.priceChange?.h24),
    },
    txns: { m5: tx("m5"), h1: tx("h1"), h6: tx("h6"), h24: tx("h24") },
    pairCreatedAt: n(pair.pairCreatedAt),
  };
}

/**
 * Aggregate token accounts into owners and label pools / known addresses.
 * accounts: [{ tokenAccount, owner, amount }] (amount already in UI units)
 * labels:   { [address]: { name, type } }  type ∈ pool | lp | burn | exchange | insider | user ...
 * Returns owners sorted by amount desc with `pct` of `supply`.
 */
export function aggregateHolders(accounts, { supply, labels = {}, poolAddresses = [] } = {}) {
  const pools = new Set(poolAddresses.filter(Boolean));
  const byOwner = new Map();
  for (const a of accounts || []) {
    if (!a || !a.owner || !(a.amount > 0)) continue;
    const cur = byOwner.get(a.owner) || { owner: a.owner, amount: 0, accounts: [] };
    cur.amount += a.amount;
    cur.accounts.push(a.tokenAccount || null);
    byOwner.set(a.owner, cur);
  }
  const out = [];
  for (const h of byOwner.values()) {
    const label = labels[h.owner] || null;
    const type = label?.type || (pools.has(h.owner) ? "pool" : "unknown");
    out.push({
      ...h,
      pct: supply > 0 ? (h.amount / supply) * 100 : null,
      label: label?.name || (pools.has(h.owner) ? "pool" : null),
      type,
      isPool: type === "pool" || type === "lp" || type === "burn",
    });
  }
  out.sort((a, b) => b.amount - a.amount);
  return out;
}

/** Concentration stats over non-pool holders. */
export function concentration(holders) {
  const real = (holders || []).filter((h) => !h.isPool && h.pct != null);
  const sum = (n) => real.slice(0, n).reduce((s, h) => s + h.pct, 0);
  return {
    holdersConsidered: real.length,
    top1Pct: round(sum(1)),
    top5Pct: round(sum(5)),
    top10Pct: round(sum(10)),
    top20Pct: round(sum(20)),
    poolPct: round((holders || []).filter((h) => h.isPool).reduce((s, h) => s + (h.pct || 0), 0)),
  };
}

/**
 * Compare two holder lists (previous → current) and describe every whale move.
 * Both inputs are arrays from aggregateHolders. Pools are ignored.
 */
export function diffHolders(prev, curr, thresholds = DEFAULT_THRESHOLDS) {
  const t = resolveThresholds(thresholds);
  const p = new Map((prev || []).filter((h) => !h.isPool).map((h) => [h.owner, h]));
  const c = new Map((curr || []).filter((h) => !h.isPool).map((h) => [h.owner, h]));
  const moves = [];
  for (const [owner, now] of c) {
    const before = p.get(owner);
    if (!before) {
      if (prev && prev.length)
        moves.push({
          owner,
          kind: "NEW_WHALE",
          before: 0,
          after: now.amount,
          changePct: null,
          pct: now.pct,
        });
      continue;
    }
    const changePct =
      before.amount > 0 ? ((now.amount - before.amount) / before.amount) * 100 : null;
    if (changePct == null) continue;
    if (changePct <= -t.whaleExitPct) moves.push(mk(owner, "WHALE_EXIT", before, now, changePct));
    else if (changePct <= -t.whaleSellPct)
      moves.push(mk(owner, "WHALE_SELL", before, now, changePct));
    else if (changePct >= t.whaleAccumulatePct)
      moves.push(mk(owner, "WHALE_ACCUMULATE", before, now, changePct));
  }
  for (const [owner, before] of p) {
    if (!c.has(owner)) {
      // Left the top-N window. We only observe the top-N, so "gone from the
      // list" is not proof of a full exit; it is reported as LEFT_TOP.
      moves.push({
        owner,
        kind: "LEFT_TOP",
        before: before.amount,
        after: null,
        changePct: null,
        pct: before.pct,
      });
    }
  }
  const order = { WHALE_EXIT: 0, WHALE_SELL: 1, LEFT_TOP: 2, NEW_WHALE: 3, WHALE_ACCUMULATE: 4 };
  moves.sort((a, b) => order[a.kind] - order[b.kind] || (b.before || 0) - (a.before || 0));
  return moves;
}

function mk(owner, kind, before, now, changePct) {
  return {
    owner,
    kind,
    before: before.amount,
    after: now.amount,
    changePct: round(changePct),
    pct: now.pct,
  };
}

/**
 * Evaluate all rules for one token. Returns { level, score, signals[] }.
 * Every signal carries the rule id, the observed value and the threshold, so
 * the report can state exactly WHY it fired (no interpretation is added).
 *
 * input: {
 *   holders, market, prevMarket, rug: { insiderPct, lpLockedPct, mintAuthority, freezeAuthority, risks[] },
 *   moves (from diffHolders), positionTokens, positionUsd
 * }
 */
export function evaluateSignals(input, thresholds = DEFAULT_THRESHOLDS) {
  const t = resolveThresholds(thresholds);
  const s = [];
  const add = (id, severity, value, threshold, detail) =>
    s.push({ id, severity, value, threshold, detail });
  const W = { WARN: 1, DANGER: 3 };

  const conc = concentration(input.holders || []);
  if (conc.top10Pct != null && conc.holdersConsidered > 0) {
    if (conc.top10Pct >= t.top10DangerPct)
      add(
        "TOP10_CONCENTRATION",
        "DANGER",
        conc.top10Pct,
        t.top10DangerPct,
        "top-10 no-pool holders own this % of supply"
      );
    else if (conc.top10Pct >= t.top10WarnPct)
      add(
        "TOP10_CONCENTRATION",
        "WARN",
        conc.top10Pct,
        t.top10WarnPct,
        "top-10 no-pool holders own this % of supply"
      );
    if (conc.top1Pct >= t.singleWhaleWarnPct)
      add(
        "SINGLE_WHALE",
        "WARN",
        conc.top1Pct,
        t.singleWhaleWarnPct,
        "largest non-pool holder share of supply"
      );
  }

  const rug = input.rug || {};
  if (typeof rug.insiderPct === "number" && rug.insiderPct >= t.insiderWarnPct)
    add(
      "INSIDER_SHARE",
      "WARN",
      round(rug.insiderPct),
      t.insiderWarnPct,
      "RugCheck insider-flagged holders share of supply"
    );
  if (typeof rug.lpLockedPct === "number" && rug.lpLockedPct < t.lpLockedMinPct)
    add(
      "LP_UNLOCKED",
      "DANGER",
      round(rug.lpLockedPct),
      t.lpLockedMinPct,
      "share of LP tokens locked/burned (RugCheck)"
    );
  if (rug.mintAuthority)
    add(
      "MINT_AUTHORITY",
      "DANGER",
      rug.mintAuthority,
      null,
      "mint authority still set: supply can be inflated"
    );
  if (rug.freezeAuthority)
    add(
      "FREEZE_AUTHORITY",
      "WARN",
      rug.freezeAuthority,
      null,
      "freeze authority still set: accounts can be frozen"
    );
  for (const r of rug.risks || []) {
    if (r?.level === "danger")
      add(`RUGCHECK:${r.name}`, "DANGER", r.value ?? null, null, r.description || r.name);
  }

  for (const m of input.moves || []) {
    if (m.kind === "WHALE_EXIT")
      add(
        "WHALE_EXIT",
        "DANGER",
        m.changePct,
        -t.whaleExitPct,
        `${short(m.owner)} balance ${fmtNum(m.before)} → ${fmtNum(m.after)}`
      );
    else if (m.kind === "WHALE_SELL")
      add(
        "WHALE_SELL",
        "WARN",
        m.changePct,
        -t.whaleSellPct,
        `${short(m.owner)} balance ${fmtNum(m.before)} → ${fmtNum(m.after)}`
      );
    else if (m.kind === "LEFT_TOP")
      add(
        "WHALE_LEFT_TOP",
        "WARN",
        null,
        null,
        `${short(m.owner)} no longer in the observed top list (had ${fmtNum(m.before)})`
      );
  }

  const mk = input.market || null;
  const pm = input.prevMarket || null;
  if (mk) {
    if (pm?.liquidityUsd > 0 && mk.liquidityUsd != null) {
      const d = ((mk.liquidityUsd - pm.liquidityUsd) / pm.liquidityUsd) * 100;
      if (d <= -t.liquidityDropPct)
        add(
          "LIQUIDITY_DROP",
          "DANGER",
          round(d),
          -t.liquidityDropPct,
          `pool liquidity ${fmtUsd(pm.liquidityUsd)} → ${fmtUsd(mk.liquidityUsd)} since previous snapshot`
        );
    }
    if (mk.priceChange?.h1 != null && mk.priceChange.h1 <= t.priceDrop1hPct)
      add(
        "PRICE_DROP_1H",
        "WARN",
        mk.priceChange.h1,
        t.priceDrop1hPct,
        "DexScreener 1h price change"
      );
    if (mk.priceChange?.h24 != null && mk.priceChange.h24 <= t.priceDrop24hPct)
      add(
        "PRICE_DROP_24H",
        "WARN",
        mk.priceChange.h24,
        t.priceDrop24hPct,
        "DexScreener 24h price change"
      );
    const h1 = mk.txns?.h1;
    if (h1 && h1.buys + h1.sells >= t.minTxnsForRatio && h1.buys > 0) {
      const ratio = h1.sells / h1.buys;
      if (ratio >= t.sellBuyRatioWarn)
        add(
          "SELL_PRESSURE_1H",
          "WARN",
          round(ratio),
          t.sellBuyRatioWarn,
          `${h1.sells} sells vs ${h1.buys} buys in the last hour`
        );
    }
    if (mk.liquidityUsd != null && mk.marketCapUsd > 0) {
      const r = (mk.liquidityUsd / mk.marketCapUsd) * 100;
      if (r < t.liqToMcapMinPct)
        add(
          "THIN_LIQUIDITY",
          "WARN",
          round(r),
          t.liqToMcapMinPct,
          `liquidity is this % of market cap (${fmtUsd(mk.liquidityUsd)} / ${fmtUsd(mk.marketCapUsd)})`
        );
    }
    const posUsd =
      input.positionUsd ??
      (input.positionTokens != null && mk.priceUsd != null
        ? input.positionTokens * mk.priceUsd
        : null);
    if (posUsd != null && mk.liquidityUsd > 0) {
      const r = (posUsd / mk.liquidityUsd) * 100;
      if (r >= t.positionToLiqWarnPct)
        add(
          "POSITION_VS_LIQUIDITY",
          "WARN",
          round(r),
          t.positionToLiqWarnPct,
          `your position (${fmtUsd(posUsd)}) is this % of pool liquidity (${fmtUsd(mk.liquidityUsd)}); exiting at once would move the price`
        );
    }
  }

  // ---- entry-side guards: these fire on the way UP, not down ----
  if (mk) {
    const up1h = mk.priceChange?.h1;
    const up24h = mk.priceChange?.h24;
    if (up1h != null && up1h >= t.fomoPump1hPct) {
      add(
        "FOMO_RISK_1H",
        "WARN",
        up1h,
        t.fomoPump1hPct,
        "el precio ya ha subido esto en 1h: comprar ahora es comprar despues del movimiento"
      );
    }
    if (up24h != null && up24h >= t.fomoPump24hPct) {
      add(
        "FOMO_RISK_24H",
        "WARN",
        up24h,
        t.fomoPump24hPct,
        "el precio ya ha subido esto en 24h: comprar ahora es comprar despues del movimiento"
      );
    }
    if (mk.pairCreatedAt != null) {
      const ageDays = (Date.now() - mk.pairCreatedAt) / 86400000;
      if (ageDays < t.recentLaunchDays) {
        add(
          "RECENT_LAUNCH",
          "WARN",
          round(ageDays, 1),
          t.recentLaunchDays,
          "el par tiene menos dias que el umbral: sin historial suficiente para juzgar nada"
        );
      }
    }
  }
  if (input.isPumpFun) {
    add(
      "PUMP_FUN_ORIGIN",
      "WARN",
      null,
      null,
      "mint acabado en 'pump': lanzado en pump.fun. Indica el lugar de lanzamiento, NO si hay proyecto detras"
    );
  }

  const score = s.reduce((a, x) => a + W[x.severity], 0);
  // No market data AND no holders observed is NOT a clean bill of health.
  const noData = !mk && conc.holdersConsidered === 0;
  const level = s.some((x) => x.severity === "DANGER")
    ? LEVELS.DANGER
    : s.length
      ? LEVELS.WARN
      : noData
        ? LEVELS.NODATA
        : LEVELS.OK;
  return { level, score, signals: s, concentration: conc };
}

/** Stable key used to de-duplicate alerts within a cooldown window. */
export function alertKey(symbol, signal) {
  const v =
    signal.value == null
      ? ""
      : typeof signal.value === "number"
        ? Math.round(signal.value)
        : String(signal.value);
  return `${symbol}|${signal.id}|${v}`;
}

/** Filter signals whose key fired within `cooldownMs` (lastFired: { key: ts }). Returns [fresh, nextLastFired]. */
export function dedupeAlerts(
  symbol,
  signals,
  lastFired = {},
  now = Date.now(),
  cooldownMs = 6 * 3600 * 1000
) {
  const next = { ...lastFired };
  const fresh = [];
  for (const sg of signals) {
    const k = alertKey(symbol, sg);
    if (next[k] && now - next[k] < cooldownMs) continue;
    next[k] = now;
    fresh.push(sg);
  }
  return [fresh, next];
}

/** Render a Markdown report for one run. results: [{ symbol, mint, market, holders, evaluation, moves, rug }] */
export function renderReport(results, { generatedAt = new Date(), title = "Whale Watch" } = {}) {
  const L = [];
  L.push(`# ${title} — ${generatedAt.toISOString()}`);
  L.push("");
  L.push(
    "| Token | Nivel | Precio | Liquidez | MCap | Liq/MCap | 1h | 24h | Top10 no-pool | Señales |"
  );
  L.push("|---|---|---:|---:|---:|---:|---:|---:|---:|---|");
  for (const r of results) {
    const m = r.market || {};
    const e = r.evaluation || { level: "?", signals: [], concentration: {} };
    const liqR =
      m.liquidityUsd != null && m.marketCapUsd > 0
        ? round((m.liquidityUsd / m.marketCapUsd) * 100) + "%"
        : "n/d";
    L.push(
      `| ${r.symbol} | ${e.level} | ${m.priceUsd != null ? "$" + fmtPrice(m.priceUsd) : "n/d"} | ${fmtUsd(m.liquidityUsd)} | ${fmtUsd(m.marketCapUsd)} | ${liqR} | ${pct(m.priceChange?.h1)} | ${pct(m.priceChange?.h24)} | ${e.concentration?.top10Pct != null ? e.concentration.top10Pct + "%" : "n/d"} | ${e.signals.map((s) => s.id).join(", ") || "-"} |`
    );
  }
  for (const r of results) {
    L.push("");
    L.push(`## ${r.symbol} (${r.mint || "mint sin resolver"}) — ${r.evaluation?.level || "?"}`);
    if (r.error) {
      L.push(`- ERROR: ${r.error}`);
      continue;
    }
    const e = r.evaluation;
    if (e?.signals?.length) {
      L.push("");
      L.push("| Señal | Severidad | Valor | Umbral | Detalle |");
      L.push("|---|---|---:|---:|---|");
      for (const s of e.signals)
        L.push(
          `| ${s.id} | ${s.severity} | ${fmtAny(s.value)} | ${fmtAny(s.threshold)} | ${s.detail} |`
        );
    } else {
      L.push("- Sin señales con los umbrales configurados.");
    }
    if (r.moves?.length) {
      L.push("");
      L.push("Movimientos de holders desde el snapshot anterior:");
      for (const m of r.moves)
        L.push(
          `- ${m.kind} ${m.owner}: ${fmtNum(m.before)} → ${fmtNum(m.after)}${m.changePct != null ? ` (${m.changePct}%)` : ""}`
        );
    }
    if (r.holders?.length) {
      L.push("");
      L.push("| # | Owner | Tipo | Cantidad | % supply |");
      L.push("|---:|---|---|---:|---:|");
      r.holders
        .slice(0, 20)
        .forEach((h, i) =>
          L.push(
            `| ${i + 1} | ${h.owner} | ${h.label || h.type} | ${fmtNum(h.amount)} | ${h.pct != null ? round(h.pct) + "%" : "n/d"} |`
          )
        );
    }
    if (r.rug) {
      L.push("");
      L.push(
        `RugCheck: score=${fmtAny(r.rug.scoreNormalised ?? r.rug.score)} insiders=${fmtAny(r.rug.insiderPct)}% lpLocked=${fmtAny(r.rug.lpLockedPct)}% mintAuthority=${r.rug.mintAuthority || "none"} freezeAuthority=${r.rug.freezeAuthority || "none"}`
      );
    }
  }
  L.push("");
  L.push(
    "_Los umbrales son reglas configuradas por el usuario (tokens.json → thresholds). Las señales describen datos observados; no son predicciones._"
  );
  return L.join("\n");
}

// ---------- formatting helpers ----------
export function round(v, d = 2) {
  if (v == null || !Number.isFinite(v)) return null;
  const f = 10 ** d;
  return Math.round(v * f) / f;
}
export function fmtUsd(v) {
  if (v == null || !Number.isFinite(v)) return "n/d";
  if (Math.abs(v) >= 1e9) return "$" + (v / 1e9).toFixed(2) + "B";
  if (Math.abs(v) >= 1e6) return "$" + (v / 1e6).toFixed(2) + "M";
  if (Math.abs(v) >= 1e3) return "$" + (v / 1e3).toFixed(1) + "K";
  return "$" + v.toFixed(2);
}
export function fmtNum(v) {
  if (v == null || !Number.isFinite(v)) return "n/d";
  if (Math.abs(v) >= 1e9) return (v / 1e9).toFixed(2) + "B";
  if (Math.abs(v) >= 1e6) return (v / 1e6).toFixed(2) + "M";
  if (Math.abs(v) >= 1e3) return (v / 1e3).toFixed(1) + "K";
  return String(round(v, 4));
}
export function fmtPrice(v) {
  if (v == null || !Number.isFinite(v)) return "n/d";
  if (v >= 1) return v.toFixed(4);
  return v.toPrecision(4);
}
export function pct(v) {
  return v == null || !Number.isFinite(v) ? "n/d" : (v > 0 ? "+" : "") + round(v, 1) + "%";
}
export function short(addr) {
  return typeof addr === "string" && addr.length > 12
    ? addr.slice(0, 4) + "…" + addr.slice(-4)
    : String(addr);
}
function fmtAny(v) {
  if (v == null) return "-";
  if (typeof v === "number") return String(round(v));
  return String(v);
}

/**
 * Minimal Markdown → HTML for the report (headings, tables, lists, paragraphs, _em_).
 * User rule: every report is always written as BOTH .md and .html.
 */
export function renderHtml(md, { title = "Whale Watch" } = {}) {
  const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const inline = (s) =>
    esc(s)
      .replace(/_([^_]+)_/g, "<em>$1</em>")
      .replace(/`([^`]+)`/g, "<code>$1</code>");
  const lines = md.split("\n");
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const l = lines[i];
    if (/^#{1,3} /.test(l)) {
      const n = l.match(/^#+/)[0].length;
      out.push(`<h${n}>${inline(l.slice(n + 1))}</h${n}>`);
      i++;
    } else if (l.startsWith("|")) {
      const rows = [];
      while (i < lines.length && lines[i].startsWith("|")) rows.push(lines[i++]);
      const cells = (r) =>
        r
          .slice(1, -1)
          .split("|")
          .map((c) => c.trim());
      const head = cells(rows[0]);
      const body = rows.slice(2).map(cells);
      out.push(
        "<table><thead><tr>" +
          head.map((c) => `<th>${inline(c)}</th>`).join("") +
          "</tr></thead><tbody>"
      );
      for (const r of body) {
        const level = r[1] || "";
        const cls = /PELIGRO|DANGER/.test(level)
          ? ' class="danger"'
          : /ATENCION|WARN/.test(level)
            ? ' class="warn"'
            : "";
        out.push(`<tr${cls}>` + r.map((c) => `<td>${inline(c)}</td>`).join("") + "</tr>");
      }
      out.push("</tbody></table>");
    } else if (l.startsWith("- ")) {
      out.push("<ul>");
      while (i < lines.length && lines[i].startsWith("- "))
        out.push(`<li>${inline(lines[i++].slice(2))}</li>`);
      out.push("</ul>");
    } else if (l.trim() === "") {
      i++;
    } else {
      out.push(`<p>${inline(l)}</p>`);
      i++;
    }
  }
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>
<style>body{font:14px/1.45 system-ui,sans-serif;margin:16px;max-width:1200px;color:#111;background:#fff}@media(prefers-color-scheme:dark){body{color:#eee;background:#121212}th{background:#222}code{background:#222}}
table{border-collapse:collapse;margin:8px 0;width:100%;font-size:13px}th,td{border:1px solid #8884;padding:4px 6px;text-align:left;word-break:break-all}th{background:#eee}
tr.danger td{background:#c0392b33}tr.warn td{background:#f39c1233}h1{font-size:20px}h2{font-size:16px;margin-top:24px}code{background:#eee;padding:0 3px}</style></head><body>
${out.join("\n")}
</body></html>
`;
}
