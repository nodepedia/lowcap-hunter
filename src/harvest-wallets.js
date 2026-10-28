import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DATA_DIR,
  gmgnLimiter,
  loadSeededTokens,
  loadWalletsDb,
  readJsonSafe,
  saveSeededTokens,
  saveWalletsDb,
  writeJsonAtomic,
} from "./limiter.js";

const SOL_ADDR_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const BAD_WALLET_TAGS = new Set(["arbitrager", "mev_bot", "dex_bot", "scammer", "phishing"]);
const BAD_TOKEN_TRADER_TAGS = new Set(["creator", "dev_team", "bundler", "rat_trader", "dex_bot"]);

function ensureWalletRecord(db, address) {
  if (!db.wallets[address]) {
    db.wallets[address] = {
      address,
      firstSeenAt: new Date().toISOString(),
      sources: [],
      tags: [],
      makerTokenTags: [],
      name: null,
      twitterUsername: null,
      nativeBalanceSol: null,
      observedTokens: {},
      smartMoneyTrades: 0,
      smartMoneyVolumeUsd: 0,
      profits7d: null,
      profits30d: null,
      stats7d: null,
      helius: null,
      filterResult: null,
      scoreResult: null,
    };
  }
  return db.wallets[address];
}

function ingestTokenTradersList(db, tokenMeta, tradersList) {
  let added = 0;
  for (const t of tradersList || []) {
    const addr = t.address;
    if (!addr || !SOL_ADDR_RE.test(addr)) continue;
    if (t.is_suspicious) continue;

    const wTags = Array.isArray(t.tags) ? t.tags : [];
    const mTags = Array.isArray(t.maker_token_tags) ? t.maker_token_tags : [];

    if (wTags.some((tag) => BAD_WALLET_TAGS.has(tag))) continue;
    if (mTags.some((tag) => BAD_TOKEN_TRADER_TAGS.has(tag))) continue;

    const buyCount = Number(t.buy_tx_count_cur || 0);
    const sellCount = Number(t.sell_tx_count_cur || 0);
    if (buyCount === 0) continue; // ignore pure transfer-in dumpers

    const startHold = Number(t.start_holding_at || 0);
    const endHold = Number(t.end_holding_at || 0);
    const holdSec = startHold > 0 && endHold >= startHold ? endHold - startHold : null;
    if (holdSec !== null && holdSec < 4 && sellCount > 0) {
      // Atomic / 0-second flash bot
      continue;
    }

    const realizedProfit = Number(t.realized_profit || 0);
    const totalProfit = Number(t.profit || realizedProfit || 0);
    const totalCost = Number(t.total_cost || t.history_bought_cost || 0);

    // Only harvest traders who actually made meaningful profit on this lowcap token
    if (totalProfit < 60 && realizedProfit < 45) continue;

    const rec = ensureWalletRecord(db, addr);
    if (!rec.sources.includes("token_traders")) rec.sources.push("token_traders");
    for (const tag of wTags) {
      if (!rec.tags.includes(tag)) rec.tags.push(tag);
    }
    for (const tag of mTags) {
      if (!rec.makerTokenTags.includes(tag)) rec.makerTokenTags.push(tag);
    }
    if (t.name && !rec.name) rec.name = t.name;
    if (t.twitter_username && !rec.twitterUsername) rec.twitterUsername = t.twitter_username;
    if (t.native_balance != null) {
      const lamports = Number(t.native_balance);
      if (Number.isFinite(lamports) && lamports >= 0) {
        rec.nativeBalanceSol = Number((lamports / 1e9).toFixed(4));
      }
    }

    rec.observedTokens[tokenMeta.address] = {
      symbol: tokenMeta.symbol || "LOWCAP",
      profit: Number(totalProfit.toFixed(2)),
      realizedProfit: Number(realizedProfit.toFixed(2)),
      totalCost: Number(totalCost.toFixed(2)),
      pnlRatio: Number((t.realized_pnl ?? t.profit_change ?? 0).toFixed(4)),
      buyTxCount: buyCount,
      sellTxCount: sellCount,
      holdSec,
      lastActiveTimestamp: t.last_active_timestamp || null,
    };
    added++;
  }
  return added;
}

export async function runHarvestWallets(maxTokensToQuery = 6) {
  console.log("=== [Step 2] Harvesting Candidate Lowcap Wallets ===");
  const db = loadWalletsDb();
  const seeded = loadSeededTokens();

  // 1. Harvest from Smart Money Trade Feed (reuse cached test_smartmoney.json if < 20 min old, else fetch fresh)
  const smFile = path.join(DATA_DIR, "test_smartmoney.json");
  let smData = null;
  if (fs.existsSync(smFile)) {
    const stat = fs.statSync(smFile);
    if (Date.now() - stat.mtimeMs < 20 * 60 * 1000) {
      smData = readJsonSafe(smFile, null);
      console.log("[harvest] Using recent cached smartmoney feed (test_smartmoney.json).");
    }
  }
  if (!smData?.list) {
    smData = await gmgnLimiter.call("track.smartmoney(sol, 200)", (client) =>
      client.getSmartMoney("sol", 200)
    );
    writeJsonAtomic(smFile, smData);
  }

  let smWalletsCount = 0;
  for (const tx of smData?.list || []) {
    const maker = tx.maker;
    if (!maker || !SOL_ADDR_RE.test(maker)) continue;
    const tags = tx.maker_info?.tags || [];
    if (tags.some((t) => BAD_WALLET_TAGS.has(t))) continue; // skip arbitragers & mev_bots

    const rec = ensureWalletRecord(db, maker);
    if (!rec.sources.includes("smartmoney_feed")) rec.sources.push("smartmoney_feed");
    for (const tag of tags) {
      if (!rec.tags.includes(tag)) rec.tags.push(tag);
    }
    if (tx.maker_info?.name && !rec.name) rec.name = tx.maker_info.name;
    if (tx.maker_info?.twitter_username && !rec.twitterUsername) {
      rec.twitterUsername = tx.maker_info.twitter_username;
    }
    rec.smartMoneyTrades = (rec.smartMoneyTrades || 0) + 1;
    rec.smartMoneyVolumeUsd = Number(
      ((rec.smartMoneyVolumeUsd || 0) + Number(tx.amount_usd || 0)).toFixed(2)
    );
    if (tx.base_address && SOL_ADDR_RE.test(tx.base_address) && !rec.observedTokens[tx.base_address]) {
      rec.observedTokens[tx.base_address] = {
        symbol: tx.base_token?.symbol || "SM_TOK",
        profit: 0,
        realizedProfit: 0,
        totalCost: Number(tx.amount_usd || 0),
        pnlRatio: 0,
        buyTxCount: tx.side === "buy" ? 1 : 0,
        sellTxCount: tx.side === "sell" ? 1 : 0,
        holdSec: null,
        lastActiveTimestamp: tx.timestamp || null,
      };
    }
    smWalletsCount++;
  }
  console.log(`[harvest] Ingested ${smWalletsCount} non-arb trades from Smart Money feed.`);

  // 2. Ingest cached test_traders.json if available
  const testTradersFile = path.join(DATA_DIR, "test_traders.json");
  if (fs.existsSync(testTradersFile)) {
    const tData = readJsonSafe(testTradersFile, null);
    if (tData?.list) {
      const c = ingestTokenTradersList(
        db,
        { address: "FpHQmU2ugwCM1nse3YzcjbmUHMCEwQS7J9eqcub8TETa", symbol: "MONERO-CHAN" },
        tData.list
      );
      console.log(`[harvest] Ingested ${c} profitable traders from cached MONERO-CHAN token traders.`);
    }
  }

  // 3. Query top traders for top unharvested seeded lowcap tokens
  const now = Date.now();
  const candidates = (seeded.tokens || []).filter((t) => {
    if (t.address === "FpHQmU2ugwCM1nse3YzcjbmUHMCEwQS7J9eqcub8TETa") return false;
    if (!t.harvestedAt) return true;
    return now - new Date(t.harvestedAt).getTime() > 3 * 3600 * 1000;
  });

  const toQuery = candidates.slice(0, maxTokensToQuery);
  for (const token of toQuery) {
    try {
      const res = await gmgnLimiter.call(
        `token.traders(${token.symbol || token.address.slice(0, 6)}, profit desc)`,
        (client) =>
          client.getTokenTopTraders("sol", token.address, {
            limit: 100,
            order_by: "profit",
            direction: "desc",
          })
      );
      const list = res?.list || (Array.isArray(res) ? res : []);
      const added = ingestTokenTradersList(db, token, list);
      token.harvestedAt = new Date().toISOString();
      console.log(
        `[harvest] Token ${token.symbol} (${token.address.slice(0, 8)}...): ${added}/${list.length} profitable clean traders harvested.`
      );
    } catch (err) {
      console.warn(`[harvest] Failed token traders for ${token.address}: ${err.message}`);
    }
  }

  saveSeededTokens(seeded);
  saveWalletsDb(db);
  const totalWallets = Object.keys(db.wallets).length;
  console.log(`[harvest] Total unique candidate wallets in DB: ${totalWallets}`);
  return db;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runHarvestWallets().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
