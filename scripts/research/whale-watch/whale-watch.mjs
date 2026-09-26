#!/usr/bin/env node
// Whale Watch — top-holder / liquidity / sell-pressure monitor for Solana tokens.
//
//   node scripts/research/whale-watch/whale-watch.mjs resolve [SYMBOL...] [--write]
//   node scripts/research/whale-watch/whale-watch.mjs snapshot [SYMBOL...]
//   node scripts/research/whale-watch/whale-watch.mjs watch [--interval 300] [SYMBOL...]
//   node scripts/research/whale-watch/whale-watch.mjs report
//   node scripts/research/whale-watch/whale-watch.mjs alert-test
//   node scripts/research/whale-watch/whale-watch.mjs screen [--min 5e6] [--max 60e6] [--category <id>] [--ids a,b,c]
//   node scripts/research/whale-watch/whale-watch.mjs categories [--q robotics]
//   node scripts/research/whale-watch/whale-watch.mjs search <name-or-symbol>
//
// Config:  scripts/research/whale-watch/tokens.json  (or --config <path>)
// State:   _artifacts/whale-watch/ (gitignored)      (or WHALE_WATCH_DIR)
// Env:     HELIUS_API_KEY (optional full holder list), TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID,
//          DISCORD_WEBHOOK_URL, SOLANA_RPC_URL (overrides tokens.json rpcUrl)
//
// Everything reported is observed data + user-configured thresholds. The tool
// never claims WHY a wallet moved; it only reports THAT it moved.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  accountsFromRugcheck,
  aggregateHolders,
  candidatesBySymbol,
  dedupeAlerts,
  detectChain,
  diffHolders,
  evaluateSignals,
  fmtUsd,
  isPumpFunMint,
  normalizeMarket,
  pickBestPair,
  renderHtml,
  renderReport,
  renderScreenReport,
  screenMarkets,
  resolveThresholds,
} from "./lib.mjs";
import {
  cgCategories,
  cgMarkets,
  cgSearch,
  dexPairsForMints,
  dexSearch,
  getAllHoldersHelius,
  getLargestHolders,
  getMintInfo,
  getRugcheck,
  sendDiscord,
  sendTelegram,
  sleep,
} from "./sources.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "../../..");

// ---------------- args ----------------
const argv = process.argv.slice(2);
const cmd = argv[0] || "help";
const flags = {};
const positional = [];
for (let i = 1; i < argv.length; i++) {
  const a = argv[i];
  if (a.startsWith("--")) {
    const k = a.slice(2);
    const next = argv[i + 1];
    if (next != null && !next.startsWith("--")) {
      flags[k] = next;
      i++;
    } else flags[k] = true;
  } else positional.push(a);
}

const configPath = path.resolve(flags.config || path.join(HERE, "tokens.json"));
const stateDir = path.resolve(
  process.env.WHALE_WATCH_DIR || path.join(REPO_ROOT, "_artifacts", "whale-watch")
);

function loadConfig() {
  const cfg = JSON.parse(fs.readFileSync(configPath, "utf8"));
  cfg.thresholds = resolveThresholds(cfg.thresholds);
  // Ordered list of Solana RPC endpoints. SOLANA_RPC_URLS (comma-separated) > SOLANA_RPC_URL >
  // tokens.json rpcUrls[] > tokens.json rpcUrl > public default. `rpc()` rotates on 403/429.
  const fromEnv = process.env.SOLANA_RPC_URLS || process.env.SOLANA_RPC_URL || "";
  const fromCfg = Array.isArray(cfg.rpcUrls) && cfg.rpcUrls.length ? cfg.rpcUrls : [cfg.rpcUrl];
  cfg.rpcUrls = (fromEnv ? fromEnv.split(",") : fromCfg)
    .map((u) => String(u || "").trim())
    .filter(Boolean);
  if (!cfg.rpcUrls.length) cfg.rpcUrls = ["https://api.mainnet-beta.solana.com"];
  cfg.rpcUrl = cfg.rpcUrls[0];
  cfg.topN = cfg.topN || 20;
  cfg.alertCooldownHours = cfg.alertCooldownHours ?? 6;
  cfg.tokens = (cfg.tokens || []).map((t) => ({ ...t, symbol: String(t.symbol) }));
  return cfg;
}
function loadLabels() {
  try {
    return JSON.parse(fs.readFileSync(path.join(HERE, "labels.json"), "utf8"));
  } catch {
    return {};
  }
}
function selectTokens(cfg) {
  if (!positional.length) return cfg.tokens;
  const want = new Set(positional.map((s) => s.toUpperCase()));
  return cfg.tokens.filter((t) => want.has(t.symbol.toUpperCase()));
}
const ensureDir = (d) => fs.mkdirSync(d, { recursive: true });
const readJson = (p, fallback) => {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return fallback;
  }
};
const writeJson = (p, v) => {
  ensureDir(path.dirname(p));
  fs.writeFileSync(p, JSON.stringify(v, null, 2));
};
const log = (...a) => console.log(new Date().toISOString(), ...a);

// ---------------- commands ----------------
async function cmdResolve(cfg) {
  const targets = selectTokens(cfg).filter((t) => flags.all || !t.mint);
  if (!targets.length)
    return log("nothing to resolve (all tokens already have a mint; use --all to re-check)");
  let changed = false;
  for (const t of targets) {
    const queries = [...new Set([t.symbol, t.name].filter(Boolean))];
    const pairs = [];
    for (const q of queries) {
      try {
        pairs.push(...(await dexSearch(q)));
      } catch (err) {
        log(`  search "${q}" failed: ${err.message}`);
      }
      await sleep(300);
    }
    const cands = candidatesBySymbol(pairs, t.symbol);
    console.log(
      `\n== ${t.symbol} (${t.name || ""}) — ${cands.length} candidate mint(s) on Solana with this symbol`
    );
    if (!cands.length) {
      console.log("   none found on DexScreener by symbol. Add the mint by hand in tokens.json.");
      continue;
    }
    cands.slice(0, 8).forEach((c, i) => {
      const age = c.pairCreatedAt ? Math.round((Date.now() - c.pairCreatedAt) / 864e5) + "d" : "?";
      console.log(
        `   ${i + 1}. ${c.mint}  name="${c.name}"  liq=${fmtUsd(c.liquidityUsd)}  vol24h=${fmtUsd(c.volume24hUsd)}  pairs=${c.pairs} (${c.dexIds.join("/")})  oldest pair ${age}`
      );
    });
    if (flags.write) {
      t.mint = cands[0].mint;
      t.mintVerified = false;
      t.mintSource = `dexscreener search, most liquid candidate on ${new Date().toISOString().slice(0, 10)} — VERIFY against your wallet`;
      changed = true;
    }
  }
  if (changed) {
    const raw = JSON.parse(fs.readFileSync(configPath, "utf8"));
    for (const t of raw.tokens || []) {
      const u = cfg.tokens.find((x) => x.symbol === t.symbol);
      if (u?.mint && !t.mint)
        Object.assign(t, { mint: u.mint, mintVerified: false, mintSource: u.mintSource });
    }
    fs.writeFileSync(configPath, JSON.stringify(raw, null, 2) + "\n");
    log(
      `wrote ${configPath} — every auto-filled mint has mintVerified=false; confirm each one against the mint shown in your wallet/DexScreener, then set mintVerified=true.`
    );
  } else if (!flags.write) {
    console.log(
      "\nRe-run with --write to store the most liquid candidate for each token (marked mintVerified=false)."
    );
  }
}

async function analyzeToken(cfg, t, labels, market) {
  const dir = path.join(stateDir, "state", t.symbol);
  const prev = readJson(path.join(dir, "latest.json"), null);
  const chain = t.chain || detectChain(t.mint);

  // Holder analysis is Solana-only: it uses the Solana JSON-RPC and RugCheck.
  // For an EVM token (0x…) only DexScreener market signals are available here.
  if (chain !== "solana") {
    const evaluation = evaluateSignals(
      {
        holders: [],
        market,
        prevMarket: prev?.market || null,
        rug: {},
        moves: [],
        isPumpFun: isPumpFunMint(t.mint),
        positionTokens: t.positionTokens ?? null,
        positionUsd: t.positionUsd ?? null,
      },
      cfg.thresholds
    );
    const snap = {
      ts: Date.now(),
      symbol: t.symbol,
      mint: t.mint,
      chain: market?.chainId || chain,
      mintVerified: t.mintVerified !== false,
      holderSource:
        "NO DISPONIBLE — token EVM: este script solo analiza holders en Solana (mercado sí)",
      holders: [],
      moves: [],
      market,
      evaluation,
    };
    ensureDir(dir);
    writeJson(path.join(dir, `${snap.ts}.json`), snap);
    writeJson(path.join(dir, "latest.json"), snap);
    return snap;
  }
  const rpcUrl = cfg.rpcUrls || cfg.rpcUrl;
  const heliusKey = process.env.HELIUS_API_KEY;

  // RugCheck first: it is the fallback for supply, decimals, authorities AND holders when the
  // public Solana RPC refuses the calls (429 "too many requests", 403 "needs a key").
  let rug = null;
  try {
    rug = await getRugcheck(t.mint);
  } catch (err) {
    log(`  ${t.symbol}: rugcheck unavailable (${err.message})`);
  }
  let mintInfo;
  let mintSource = "rpc getAccountInfo";
  try {
    mintInfo = await getMintInfo(rpcUrl, t.mint);
  } catch (err) {
    if (!(rug?.supply > 0) || rug.decimals == null) throw err;
    mintInfo = {
      decimals: rug.decimals,
      supply: rug.supply,
      mintAuthority: rug.mintAuthority,
      freezeAuthority: rug.freezeAuthority,
      program: null,
    };
    mintSource = `rugcheck (RPC no disponible: ${err.message})`;
    log(`  ${t.symbol}: mint info from RugCheck (${err.message})`);
  }
  let accounts;
  let holderSource;
  if (heliusKey) {
    accounts = await getAllHoldersHelius(
      `https://mainnet.helius-rpc.com/?api-key=${heliusKey}`,
      t.mint,
      mintInfo.decimals
    );
    holderSource = `helius getTokenAccounts (${accounts.length} accounts)`;
  } else {
    try {
      accounts = await getLargestHolders(rpcUrl, t.mint, mintInfo.decimals);
      holderSource = "rpc getTokenLargestAccounts (20 largest token accounts only)";
    } catch (err) {
      accounts = accountsFromRugcheck(rug?.topHolders, mintInfo.supply);
      if (!accounts.length) throw err;
      holderSource = `rugcheck topHolders (${accounts.length} holders; RPC no disponible: ${err.message})`;
      log(`  ${t.symbol}: holders from RugCheck (${err.message})`);
    }
  }
  const poolTokenAccounts = new Set(rug?.poolTokenAccounts || []);
  const poolOwners = new Set([
    ...(rug?.poolOwners || []),
    ...(market?.pairAddress ? [market.pairAddress] : []),
  ]);
  // Token accounts that RugCheck lists as pool vaults are pools whatever their owner.
  for (const a of accounts) if (poolTokenAccounts.has(a.tokenAccount)) poolOwners.add(a.owner);
  const mergedLabels = { ...labels, ...(rug?.labels || {}) };
  for (const h of rug?.topHolders || []) {
    if (h.insider && h.owner && !mergedLabels[h.owner])
      mergedLabels[h.owner] = { name: "rugcheck:insider", type: "insider" };
  }
  const holders = aggregateHolders(accounts, {
    supply: mintInfo.supply,
    labels: mergedLabels,
    poolAddresses: [...poolOwners],
  }).slice(0, cfg.topN);
  const moves = prev ? diffHolders(prev.holders, holders, cfg.thresholds) : [];
  const rugFlat = rug
    ? {
        ...rug,
        mintAuthority: rug.mintAuthority || mintInfo.mintAuthority,
        freezeAuthority: rug.freezeAuthority || mintInfo.freezeAuthority,
      }
    : {
        mintAuthority: mintInfo.mintAuthority,
        freezeAuthority: mintInfo.freezeAuthority,
        risks: [],
        insiderPct: null,
        lpLockedPct: null,
      };
  const evaluation = evaluateSignals(
    {
      holders,
      market,
      prevMarket: prev?.market || null,
      rug: rugFlat,
      moves,
      isPumpFun: isPumpFunMint(t.mint),
      positionTokens: t.positionTokens ?? null,
      positionUsd: t.positionUsd ?? null,
    },
    cfg.thresholds
  );
  const snap = {
    ts: Date.now(),
    symbol: t.symbol,
    mint: t.mint,
    mintVerified: t.mintVerified !== false,
    holderSource,
    mintSource,
    supply: mintInfo.supply,
    decimals: mintInfo.decimals,
    market,
    holders,
    moves,
    rug: rugFlat && {
      ...rugFlat,
      topHolders: undefined,
      labels: undefined,
      poolTokenAccounts: undefined,
      poolOwners: undefined,
    },
    evaluation,
  };
  ensureDir(dir);
  writeJson(path.join(dir, `${snap.ts}.json`), snap);
  writeJson(path.join(dir, "latest.json"), snap);
  // keep the last 500 snapshots per token
  const files = fs
    .readdirSync(dir)
    .filter((f) => /^\d+\.json$/.test(f))
    .sort();
  for (const f of files.slice(0, Math.max(0, files.length - 500))) fs.unlinkSync(path.join(dir, f));
  return snap;
}

async function cmdSnapshot(cfg, { quiet = false } = {}) {
  const labels = loadLabels();
  const tokens = selectTokens(cfg);
  const withMint = tokens.filter((t) => t.mint);
  for (const t of tokens.filter((x) => !x.mint))
    log(`skip ${t.symbol}: no mint in tokens.json (run: whale-watch.mjs resolve ${t.symbol})`);
  for (const t of withMint.filter((x) => x.mintVerified === false))
    log(`warning ${t.symbol}: mint ${t.mint} is marked mintVerified=false`);
  if (!withMint.length) return [];

  let pairs = [];
  try {
    pairs = await dexPairsForMints(withMint.map((t) => t.mint));
  } catch (err) {
    log(`dexscreener failed: ${err.message}`);
  }
  const results = [];
  for (const t of withMint) {
    const market = normalizeMarket(
      pickBestPair(pairs, { mint: t.mint, chain: t.chain || detectChain(t.mint) })
    );
    try {
      const snap = await analyzeToken(cfg, t, labels, market);
      results.push(snap);
      if (!quiet) {
        const e = snap.evaluation;
        log(
          `${t.symbol.padEnd(9)} ${e.level.padEnd(8)} price=${market?.priceUsd ?? "n/d"} liq=${fmtUsd(market?.liquidityUsd)} top10=${e.concentration.top10Pct ?? "n/d"}% signals=${e.signals.map((s) => s.id).join(",") || "-"}`
        );
      }
    } catch (err) {
      log(`${t.symbol}: ERROR ${err.message}`);
      results.push({
        symbol: t.symbol,
        mint: t.mint,
        error: err.message,
        market,
        evaluation: { level: "ERROR", signals: [], concentration: {} },
      });
    }
    await sleep(400);
  }
  const md = renderReport(results, { title: "Whale Watch — snapshot" });
  const reportsDir = path.join(stateDir, "reports");
  ensureDir(reportsDir);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  // Always write BOTH formats (operator rule): Markdown + HTML.
  const html = renderHtml(md, { title: `Whale Watch ${stamp}` });
  fs.writeFileSync(path.join(reportsDir, `${stamp}.md`), md);
  fs.writeFileSync(path.join(reportsDir, `${stamp}.html`), html);
  fs.writeFileSync(path.join(reportsDir, "latest.md"), md);
  fs.writeFileSync(path.join(reportsDir, "latest.html"), html);
  log(`report: ${path.join(reportsDir, "latest.md")} + latest.html`);
  await dispatchAlerts(cfg, results);
  return results;
}

async function dispatchAlerts(cfg, results) {
  const alertsPath = path.join(stateDir, "alerts.json");
  let lastFired = readJson(alertsPath, {});
  const lines = [];
  for (const r of results) {
    if (!r.evaluation?.signals?.length) continue;
    const [fresh, next] = dedupeAlerts(
      r.symbol,
      r.evaluation.signals,
      lastFired,
      Date.now(),
      cfg.alertCooldownHours * 3600 * 1000
    );
    lastFired = next;
    for (const s of fresh)
      lines.push(
        `[${s.severity}] ${r.symbol} ${s.id}: ${s.detail}${s.value != null ? ` (valor ${s.value}, umbral ${s.threshold ?? "-"})` : ""}`
      );
  }
  writeJson(alertsPath, lastFired);
  if (!lines.length) return;
  const text = `Whale Watch ${new Date().toISOString()}\n` + lines.join("\n");
  console.log("\nALERTAS NUEVAS:\n" + lines.join("\n") + "\n");
  await sendAlert(text);
}

async function sendAlert(text) {
  const { TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, DISCORD_WEBHOOK_URL } = process.env;
  const jobs = [];
  if (TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID)
    jobs.push(
      sendTelegram(text, { token: TELEGRAM_BOT_TOKEN, chatId: TELEGRAM_CHAT_ID }).catch((e) =>
        log(`telegram failed: ${e.message}`)
      )
    );
  if (DISCORD_WEBHOOK_URL)
    jobs.push(
      sendDiscord(text, { webhookUrl: DISCORD_WEBHOOK_URL }).catch((e) =>
        log(`discord failed: ${e.message}`)
      )
    );
  if (!jobs.length)
    log(
      "(no alert channel configured: set TELEGRAM_BOT_TOKEN+TELEGRAM_CHAT_ID or DISCORD_WEBHOOK_URL)"
    );
  await Promise.all(jobs);
}

async function cmdWatch(cfg) {
  const interval = Math.max(60, Number(flags.interval) || 300);
  log(`watching ${selectTokens(cfg).length} token(s) every ${interval}s — Ctrl+C to stop`);
  for (;;) {
    try {
      await cmdSnapshot(cfg);
    } catch (err) {
      log(`snapshot failed: ${err.message}`);
    }
    await sleep(interval * 1000);
  }
}

function cmdReport(cfg) {
  const results = [];
  for (const t of selectTokens(cfg)) {
    const snap = readJson(path.join(stateDir, "state", t.symbol, "latest.json"), null);
    if (snap) results.push(snap);
  }
  if (!results.length) return log("no snapshots yet — run `snapshot` first");
  const md = renderReport(results, { title: "Whale Watch — último snapshot" });
  const reportsDir = path.join(stateDir, "reports");
  ensureDir(reportsDir);
  fs.writeFileSync(
    path.join(reportsDir, "latest.html"),
    renderHtml(md, { title: "Whale Watch — último snapshot" })
  );
  console.log(md);
}

function help() {
  console.log(
    fs
      .readFileSync(fileURLToPath(import.meta.url), "utf8")
      .split("\n")
      .slice(1, 17)
      .map((l) => l.replace(/^\/\/ ?/, ""))
      .join("\n")
  );
}

// ---------------- CoinGecko screener ----------------
function parseNum(v, dflt) {
  if (v == null || v === true) return dflt;
  const n = Number(String(v).replace(/[_,]/g, ""));
  return Number.isFinite(n) ? n : dflt;
}

async function cmdScreen() {
  const minMcap = parseNum(flags.min, 5e6);
  const maxMcap = parseNum(flags.max, 60e6);
  const categories = []
    .concat(flags.category || [])
    .flatMap((c) => String(c).split(","))
    .filter(Boolean);
  let ids = []
    .concat(flags.ids || [])
    .flatMap((c) => String(c).split(","))
    .map((x) => x.trim())
    .filter(Boolean);
  if (!categories.length && !ids.length) {
    const preset = readJson(path.join(HERE, "screen.json"), null);
    ids = preset?.ids || [];
    if (!ids.length)
      return log("nothing to screen: pass --category <id> (see `categories`) or --ids a,b,c");
    log(`using ${ids.length} ids from screen.json`);
  }
  const rows = [];
  const notes = [];
  for (const c of categories) {
    try {
      const r = await cgMarkets({ category: c });
      rows.push(...r);
      notes.push(`categoría \`${c}\`: ${r.length} monedas leídas`);
    } catch (err) {
      log(`category ${c}: ${err.message}`);
      notes.push(`categoría \`${c}\`: ERROR ${err.message}`);
    }
    await sleep(2200); // CoinGecko public tier ≈ 30 req/min
  }
  for (let i = 0; i < ids.length; i += 100) {
    const chunk = ids.slice(i, i + 100);
    try {
      const r = await cgMarkets({ ids: chunk });
      rows.push(...r);
      const missing = chunk.filter((id) => !r.some((x) => x.id === id));
      if (missing.length)
        notes.push(`ids sin datos en CoinGecko: ${missing.join(", ")} (usa \`search\`)`);
    } catch (err) {
      log(`ids chunk: ${err.message}`);
    }
    await sleep(2200);
  }
  const screened = screenMarkets(rows, { minMcap, maxMcap });
  const md = renderScreenReport(screened, { minMcap, maxMcap, notes });
  const reportsDir = path.join(stateDir, "reports");
  ensureDir(reportsDir);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const html = renderHtml(md, { title: `Whale Watch screen ${stamp}` });
  fs.writeFileSync(path.join(reportsDir, `screen-${stamp}.md`), md);
  fs.writeFileSync(path.join(reportsDir, `screen-${stamp}.html`), html);
  fs.writeFileSync(path.join(reportsDir, "screen-latest.md"), md);
  fs.writeFileSync(path.join(reportsDir, "screen-latest.html"), html);
  console.log(md);
  log(`screen: ${path.join(reportsDir, "screen-latest.md")} + screen-latest.html`);
}

async function cmdCategories() {
  const q = typeof flags.q === "string" ? flags.q : "";
  const cats = await cgCategories(q);
  if (!cats.length) return log(`no CoinGecko category matches "${q}"`);
  for (const c of cats) console.log(`${c.category_id.padEnd(40)} ${c.name}`);
}

async function cmdSearch() {
  const q = positional.join(" ");
  if (!q) return log("usage: search <name-or-symbol>");
  const hits = await cgSearch(q);
  if (!hits.length) return log(`no CoinGecko match for "${q}"`);
  for (const h of hits.slice(0, 15))
    console.log(
      `${h.id.padEnd(32)} ${h.symbol.toUpperCase().padEnd(10)} ${h.name}${h.rank ? `  (rank ${h.rank})` : ""}`
    );
}

// ---------------- main ----------------
const main = async () => {
  if (cmd === "help" || cmd === "--help" || cmd === "-h") return help();
  const cfg = loadConfig();
  ensureDir(stateDir);
  switch (cmd) {
    case "resolve":
      return cmdResolve(cfg);
    case "snapshot":
      return cmdSnapshot(cfg);
    case "watch":
      return cmdWatch(cfg);
    case "report":
      return cmdReport(cfg);
    case "alert-test":
      return sendAlert("Whale Watch: mensaje de prueba");
    case "screen":
      return cmdScreen();
    case "categories":
      return cmdCategories();
    case "search":
      return cmdSearch();
    default:
      help();
      process.exitCode = 1;
  }
};
main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
