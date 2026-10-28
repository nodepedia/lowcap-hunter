import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DATA_DIR,
  gmgnLimiter,
  loadSeededTokens,
  readJsonSafe,
  saveSeededTokens,
} from "./limiter.js";

const SOL_MINT_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const IGNORED_MINTS = new Set([
  "So11111111111111111111111111111111111111112",
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
]);

async function fetchDexScreenerLowcaps() {
  const discovered = new Map();
  const queries = ["pump", "pumpswap", "bonk", "ai", "agent", "cat", "dog", "meme"];

  for (const q of queries) {
    try {
      const res = await fetch(`https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(q)}`);
      if (!res.ok) continue;
      const json = await res.json();
      for (const pair of json.pairs || []) {
        if (pair.chainId !== "solana") continue;
        const mint = pair.baseToken?.address;
        if (!mint || !SOL_MINT_RE.test(mint) || IGNORED_MINTS.has(mint)) continue;

        const mc = Number(pair.marketCap || pair.fdv || 0);
        const vol24h = Number(pair.volume?.h24 || 0);
        const liq = Number(pair.liquidity?.usd || 0);
        const txns24h = Number(pair.txns?.h24?.buys || 0) + Number(pair.txns?.h24?.sells || 0);
        const priceChange24hPct = Number(pair.priceChange?.h24 ?? pair.priceChange?.h6 ?? 0);

        if (mc >= 15000 && mc <= 4500000 && vol24h >= 25000 && liq >= 6000) {
          discovered.set(mint, {
            address: mint,
            symbol: pair.baseToken?.symbol || "UNKNOWN",
            name: pair.baseToken?.name || pair.baseToken?.symbol || "",
            marketCap: mc,
            volume24h: vol24h,
            priceChange24hPct,
            liquidity: liq,
            swaps24h: txns24h,
            smartDegenCount: 0,
            source: `dexscreener:${q}`,
            discoveredAt: new Date().toISOString(),
          });
        }
      }
    } catch (err) {
      console.warn(`[seed] DexScreener search (${q}) warning: ${err.message}`);
    }
  }

  return [...discovered.values()];
}

export async function runSeedTokens(options = {}) {
  const { skipGmgnTrending = false } = options;
  console.log("=== [Step 1] Seeding Lowcap Solana Tokens ===");
  const existing = loadSeededTokens();
  const byMint = new Map();

  for (const t of existing.tokens || []) {
    if (t?.address) byMint.set(t.address, t);
  }

  // 1. Pull tokens traded in cached/recent smartmoney feed if available
  const cachedSm = readJsonSafe(path.join(DATA_DIR, "test_smartmoney.json"), null);
  if (cachedSm?.list) {
    for (const tx of cachedSm.list) {
      const mint = tx.base_address;
      if (mint && SOL_MINT_RE.test(mint) && !IGNORED_MINTS.has(mint) && !byMint.has(mint)) {
        byMint.set(mint, {
          address: mint,
          symbol: tx.base_token?.symbol || "SM_TOKEN",
          name: tx.base_token?.symbol || "",
          marketCap: 150000,
          volume24h: 100000,
          priceChange24hPct: 0,
          liquidity: 25000,
          swaps24h: 500,
          smartDegenCount: 3,
          source: "gmgn:smartmoney-feed",
          discoveredAt: new Date().toISOString(),
        });
      }
    }
  }

  // 2. DexScreener public API (0 GMGN calls)
  const dexTokens = await fetchDexScreenerLowcaps();
  console.log(`[seed] DexScreener discovered ${dexTokens.length} lowcap Solana tokens ($15K–$4.5M MC).`);
  for (const t of dexTokens) {
    const prev = byMint.get(t.address);
    byMint.set(t.address, {
      ...prev,
      ...t,
      harvestedAt: prev?.harvestedAt || null,
      discoveredAt: prev?.discoveredAt || t.discoveredAt,
    });
  }

  // 3. GMGN Market Trending 6h lowcap filter (1 GMGN call unless skipped)
  if (!skipGmgnTrending) {
    try {
      const trending = await gmgnLimiter.call("market.trending(sol, 6h, lowcap)", (client) =>
        client.getTrendingSwaps("sol", "6h", {
          limit: 50,
          order_by: "volume",
          direction: "desc",
          min_marketcap: 15000,
          max_marketcap: 4500000,
          min_volume: 25000,
          min_liquidity: 8000,
        })
      );
      const rankList = trending?.rank || trending?.list || (Array.isArray(trending) ? trending : []);
      console.log(`[seed] GMGN market trending returned ${rankList.length} lowcap tokens.`);
      for (const item of rankList) {
        const mint = item.address || item.token_address || item.base_address;
        if (!mint || !SOL_MINT_RE.test(mint) || IGNORED_MINTS.has(mint)) continue;
        const prev = byMint.get(mint);
        byMint.set(mint, {
          address: mint,
          symbol: item.symbol || prev?.symbol || "UNKNOWN",
          name: item.name || prev?.name || "",
          marketCap: Number(item.market_cap || item.usd_market_cap || prev?.marketCap || 0),
          volume24h: Number(item.volume || item.volume_24h || prev?.volume24h || 0),
          priceChange24hPct: Number(item.price_change_percent || item.change_24h || prev?.priceChange24hPct || 0),
          liquidity: Number(item.liquidity || prev?.liquidity || 0),
          swaps24h: Number(item.swaps || item.swaps_24h || prev?.swaps24h || 0),
          smartDegenCount: Number(item.smart_degen_count || prev?.smartDegenCount || 0),
          renownedCount: Number(item.renowned_count || 0),
          source: "gmgn:trending-6h",
          harvestedAt: prev?.harvestedAt || null,
          discoveredAt: prev?.discoveredAt || new Date().toISOString(),
        });
      }
    } catch (err) {
      console.warn(`[seed] GMGN trending warning: ${err.message}`);
    }
  }

  // Score and sort tokens by lowcap smart-money & volume velocity
  const tokens = [...byMint.values()].map((t) => {
    const volMcRatio = t.marketCap > 0 ? Math.min(t.volume24h / t.marketCap, 20) : 1;
    const smBonus = (t.smartDegenCount || 0) * 8 + (t.renownedCount || 0) * 5;
    const srcBonus = String(t.source).startsWith("gmgn:") ? 15 : 5;
    return {
      ...t,
      priorityScore: Number((volMcRatio * 4 + smBonus + srcBonus).toFixed(2)),
    };
  });

  tokens.sort((a, b) => b.priorityScore - a.priorityScore);
  saveSeededTokens({ tokens });
  console.log(`[seed] Saved ${tokens.length} total seeded lowcap tokens to data/seeded-tokens.json.`);
  return tokens;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runSeedTokens().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
