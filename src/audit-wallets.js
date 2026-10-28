import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DATA_DIR,
  gmgnLimiter,
  loadWalletsDb,
  readJsonSafe,
  saveWalletsDb,
  sleep,
} from "./limiter.js";

const HELIUS_API_KEY = process.env.HELIUS_API_KEY;
const HELIUS_RPC_URL = `https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`;

export async function heliusRpcCall(method, params, maxRetries = 4) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const res = await fetch(HELIUS_RPC_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method,
        params,
      }),
    });
    if (res.status === 429) {
      await sleep(1100 * attempt);
      continue;
    }
    if (!res.ok) {
      throw new Error(`Helius HTTP ${res.status}`);
    }
    const json = await res.json();
    if (json.error) {
      if (String(json.error?.message || "").includes("429") && attempt < maxRetries) {
        await sleep(1100 * attempt);
        continue;
      }
      throw new Error(`Helius RPC error: ${JSON.stringify(json.error)}`);
    }
    return json.result;
  }
  throw new Error("Helius HTTP 429 after retries");
}

export async function batchFetchSolBalances(addresses) {
  const balances = {};
  for (let i = 0; i < addresses.length; i += 100) {
    const chunk = addresses.slice(i, i + 100);
    try {
      const res = await heliusRpcCall("getMultipleAccounts", [chunk, { commitment: "confirmed" }]);
      const vals = res?.value || [];
      for (let j = 0; j < chunk.length; j++) {
        const lamports = vals[j]?.lamports ?? 0;
        balances[chunk[j]] = Number((lamports / 1e9).toFixed(4));
      }
    } catch (err) {
      console.warn(`[audit] getMultipleAccounts warning: ${err.message}`);
    }
    await sleep(180);
  }
  return balances;
}

export async function auditWalletSignaturesWithHelius(address, solBalance) {
  const sigs = await heliusRpcCall("getSignaturesForAddress", [address, { limit: 60 }]);
  const sigList = Array.isArray(sigs) ? sigs : [];
  const nowSec = Math.floor(Date.now() / 1000);

  if (sigList.length === 0) {
    return {
      auditedAt: new Date().toISOString(),
      solBalance,
      txCountChecked: 0,
      lastTxBlockTime: null,
      daysSinceLastTx: 999,
      txPerHourRecent: 0,
      sameSlotBurstRatio: 0,
      failedTxRatio: 0,
    };
  }

  const newestTime = sigList[0]?.blockTime || nowSec;
  const oldestTime = sigList[sigList.length - 1]?.blockTime || newestTime;
  const daysSinceLastTx = Number(Math.max(0, (nowSec - newestTime) / 86400).toFixed(3));
  const spanHours = Math.max((newestTime - oldestTime) / 3600, 0.05);
  const txPerHourRecent = Number((sigList.length / spanHours).toFixed(2));

  let sameSlotCount = 0;
  let failedCount = 0;
  for (let i = 0; i < sigList.length; i++) {
    if (sigList[i].err !== null && sigList[i].err !== undefined) {
      failedCount++;
    }
    if (i > 0 && sigList[i].slot === sigList[i - 1].slot) {
      sameSlotCount++;
    }
  }

  const sameSlotBurstRatio = Number((sameSlotCount / sigList.length).toFixed(3));
  const failedTxRatio = Number((failedCount / sigList.length).toFixed(3));

  return {
    auditedAt: new Date().toISOString(),
    solBalance,
    txCountChecked: sigList.length,
    lastTxBlockTime: newestTime,
    daysSinceLastTx,
    txPerHourRecent,
    sameSlotBurstRatio,
    failedTxRatio,
  };
}

export function parseProfitItem(item) {
  const realizedProfit = Number(item.realized_profit || 0);
  const realizedCost = Number(item.realized_profit_cost || 0);
  const totalRealizedProfit = Number(item.total_realized_profit || 0);
  const totalRealizedCost = Number(item.total_realized_profit_cost || 0);
  const totalProfit = Number(item.total_profit || 0);
  const totalCost = Number(item.total_cost || 0);
  const roi = realizedCost > 0 ? realizedProfit / realizedCost : 0;
  const totalRoi = totalRealizedCost > 0 ? totalRealizedProfit / totalRealizedCost : 0;

  return {
    realizedProfit: Number(realizedProfit.toFixed(2)),
    realizedCost: Number(realizedCost.toFixed(2)),
    roi: Number(roi.toFixed(4)),
    buy: Number(item.buy || 0),
    sell: Number(item.sell || 0),
    unrealizedProfit: Number(Number(item.unrealized_profit || 0).toFixed(2)),
    totalRealizedProfit: Number(totalRealizedProfit.toFixed(2)),
    totalRealizedCost: Number(totalRealizedCost.toFixed(2)),
    totalRoi: Number(totalRoi.toFixed(4)),
    totalProfit: Number(totalProfit.toFixed(2)),
    totalCost: Number(totalCost.toFixed(2)),
    auditedAt: new Date().toISOString(),
  };
}

export function isWalletRecentlyAudited(w, maxAgeDays = 3) {
  const ts = w.lastAuditedAt || w.profits7d?.auditedAt || w.profits30d?.auditedAt;
  if (!ts || !w.profits7d || !w.profits30d) return false;
  const ageMs = Date.now() - new Date(ts).getTime();
  return ageMs < maxAgeDays * 86400 * 1000;
}

export async function runAuditWallets(options = {}) {
  const maxStatsCalls = typeof options === "number" ? options : (options.maxStatsCalls ?? 12);
  const onlyUnaudited = typeof options === "object" ? (options.onlyUnaudited ?? true) : true;
  const maxAgeDays = typeof options === "object" ? (options.maxAgeDays ?? 3) : 3;

  console.log("=== [Step 3] Auditing Candidate Wallets (GMGN Batch Profits + Helius RPC + GMGN Stats) ===");
  const db = loadWalletsDb();
  const allWallets = Object.values(db.wallets);
  console.log(`[audit] Total wallets in DB: ${allWallets.length} (onlyUnaudited=${onlyUnaudited}, maxAgeDays=${maxAgeDays})`);

  const testStatsFile = path.join(DATA_DIR, "test_stats.json");
  if (fs.existsSync(testStatsFile)) {
    const st = readJsonSafe(testStatsFile, null);
    if (st?.wallet_address && db.wallets[st.wallet_address] && !db.wallets[st.wallet_address].stats7d) {
      db.wallets[st.wallet_address].stats7d = {
        winrate: Number(st.pnl_stat?.winrate ?? 0),
        tokenNum: Number(st.pnl_stat?.token_num ?? 0),
        avgHoldingPeriodSec: Number(st.pnl_stat?.avg_holding_period ?? 0),
        pnlLtNd5: Number(st.pnl_stat?.pnl_lt_nd5_num ?? 0),
        pnlNd5To0x: Number(st.pnl_stat?.pnl_nd5_0x_num ?? 0),
        pnl0xTo2x: Number(st.pnl_stat?.pnl_0x_2x_num ?? 0),
        pnl2xTo5x: Number(st.pnl_stat?.pnl_2x_5x_num ?? 0),
        pnlGt5x: Number(st.pnl_stat?.pnl_gt_5x_num ?? 0),
        followCount: Number(st.common?.follow_count ?? 0),
        remarkCount: Number(st.common?.remark_count ?? 0),
        auditedAt: new Date().toISOString(),
      };
    }
  }

  // 3A. Batch query 7d and 30d profits (100 wallets per single POST request!)
  const needProfitsWallets = allWallets.filter((w) => {
    if (onlyUnaudited && isWalletRecentlyAudited(w, maxAgeDays)) {
      return false;
    }
    return !w.profits7d || !w.profits30d || !onlyUnaudited;
  });

  const needProfits = needProfitsWallets.map((w) => w.address);
  const newlyAuditedSet = new Set(needProfits);
  console.log(`[audit] Wallets requiring GMGN batch profit audit this run: ${needProfits.length}`);

  for (let i = 0; i < needProfits.length; i += 100) {
    const batch = needProfits.slice(i, i + 100);
    console.log(`[audit] Batch querying 7d & 30d profits for ${batch.length} wallets (chunk ${Math.floor(i / 100) + 1})...`);

    try {
      const res7d = await gmgnLimiter.call(
        `portfolio.profits(sol, 7d, ${batch.length} wallets)`,
        (client) => client.getWalletProfits("sol", batch, "7d")
      );
      for (const item of res7d?.list || []) {
        if (item.wallet_address && db.wallets[item.wallet_address]) {
          db.wallets[item.wallet_address].profits7d = parseProfitItem(item);
          db.wallets[item.wallet_address].lastAuditedAt = new Date().toISOString();
        }
      }
    } catch (err) {
      console.warn(`[audit] 7d batch profit error: ${err.message}`);
    }

    try {
      const res30d = await gmgnLimiter.call(
        `portfolio.profits(sol, 30d, ${batch.length} wallets)`,
        (client) => client.getWalletProfits("sol", batch, "30d")
      );
      for (const item of res30d?.list || []) {
        if (item.wallet_address && db.wallets[item.wallet_address]) {
          db.wallets[item.wallet_address].profits30d = parseProfitItem(item);
          db.wallets[item.wallet_address].lastAuditedAt = new Date().toISOString();
        }
      }
    } catch (err) {
      console.warn(`[audit] 30d batch profit error: ${err.message}`);
    }

    const nowIso = new Date().toISOString();
    for (const addr of batch) {
      const w = db.wallets[addr];
      if (!w) continue;
      if (!w.profits7d) w.profits7d = parseProfitItem({});
      if (!w.profits30d) w.profits30d = parseProfitItem({});
      w.lastAuditedAt = nowIso;
    }

    saveWalletsDb(db);
  }

  // 3B. Helius RPC Audit on profitable, non-extreme-HFT candidates that need Helius audit
  const heliusCandidates = Object.values(db.wallets).filter((w) => {
    if (w.helius && onlyUnaudited) return false;
    const p7 = w.profits7d?.realizedProfit || 0;
    const p30 = w.profits30d?.realizedProfit || 0;
    const trades7d = (w.profits7d?.buy || 0) + (w.profits7d?.sell || 0);
    return (p7 > 150 || p30 > 250) && trades7d <= 2500;
  });

  if (heliusCandidates.length > 0) {
    console.log(`[audit] Fetching SOL balances in batch (getMultipleAccounts) for ${heliusCandidates.length} wallets...`);
    const balances = await batchFetchSolBalances(heliusCandidates.map((w) => w.address));

    console.log(`[audit] Running paced Helius getSignaturesForAddress check for ${heliusCandidates.length} wallets...`);
    const concurrency = 2;
    for (let i = 0; i < heliusCandidates.length; i += concurrency) {
      const slice = heliusCandidates.slice(i, i + concurrency);
      await Promise.all(
        slice.map(async (w) => {
          try {
            const solBal = balances[w.address] ?? w.nativeBalanceSol ?? 0;
            const h = await auditWalletSignaturesWithHelius(w.address, solBal);
            w.helius = h;
            w.nativeBalanceSol = h.solBalance;
            w.lastAuditedAt = new Date().toISOString();
          } catch (err) {
            console.warn(`[audit] Helius check warning for ${w.address.slice(0, 8)}: ${err.message}`);
          }
        })
      );
      await sleep(260);
    }
    saveWalletsDb(db);
    console.log(`[audit] Helius RPC audit completed cleanly.`);
  } else {
    console.log(`[audit] All profitable candidates already have fresh Helius on-chain audit data.`);
  }

  // 3C. Deep GMGN portfolio stats (7d) for top un-enriched candidates
  const statsCandidates = Object.values(db.wallets)
    .filter((w) => {
      if (w.stats7d) return false;
      if (onlyUnaudited && newlyAuditedSet.size > 0 && !newlyAuditedSet.has(w.address)) return false;
      const p7 = w.profits7d?.realizedProfit || 0;
      const p30 = w.profits30d?.realizedProfit || 0;
      const trades7d = (w.profits7d?.buy || 0) + (w.profits7d?.sell || 0);
      if (p7 <= 150 && p30 <= 300) return false;
      if (trades7d > 2200 || trades7d < 2) return false;
      if (w.helius) {
        if (w.helius.daysSinceLastTx > 7) return false;
        if (w.helius.txPerHourRecent > 85) return false;
        if (w.helius.sameSlotBurstRatio > 0.45) return false;
        if (w.helius.failedTxRatio > 0.40) return false;
      }
      return true;
    })
    .sort((a, b) => {
      const scoreQuick = (w) => {
        const p7 = Math.max(0, w.profits7d?.realizedProfit || 0);
        const p30 = Math.max(0, w.profits30d?.realizedProfit || 0);
        const roi7 = Math.max(0, w.profits7d?.roi || 0);
        const tokCount = Object.keys(w.observedTokens || {}).length;
        return Math.log10(p7 + 10) * 20 + Math.log10(p30 + 10) * 10 + Math.min(roi7 * 50, 35) + tokCount * 8;
      };
      return scoreQuick(b) - scoreQuick(a);
    });

  const toFetchStats = statsCandidates.slice(0, maxStatsCalls);
  if (toFetchStats.length > 0) {
    console.log(`[audit] Fetching deep GMGN 7d portfolio stats for top ${toFetchStats.length} candidates...`);
    for (const w of toFetchStats) {
      try {
        const st = await gmgnLimiter.call(
          `portfolio.stats(sol, 7d, ${w.address.slice(0, 8)}...)`,
          (client) => client.getWalletStats("sol", [w.address], "7d")
        );
        if (st && st.pnl_stat) {
          w.stats7d = {
            winrate: Number(st.pnl_stat.winrate ?? 0),
            tokenNum: Number(st.pnl_stat.token_num ?? 0),
            avgHoldingPeriodSec: Number(st.pnl_stat.avg_holding_period ?? 0),
            pnlLtNd5: Number(st.pnl_stat.pnl_lt_nd5_num ?? 0),
            pnlNd5To0x: Number(st.pnl_stat.pnl_nd5_0x_num ?? 0),
            pnl0xTo2x: Number(st.pnl_stat.pnl_0x_2x_num ?? 0),
            pnl2xTo5x: Number(st.pnl_stat.pnl_2x_5x_num ?? 0),
            pnlGt5x: Number(st.pnl_stat.pnl_gt_5x_num ?? 0),
            followCount: Number(st.common?.follow_count ?? 0),
            remarkCount: Number(st.common?.remark_count ?? 0),
            auditedAt: new Date().toISOString(),
          };
          if (st.native_balance != null) {
            w.nativeBalanceSol = Number(Number(st.native_balance).toFixed(4));
          }
          if (Array.isArray(st.common?.tags)) {
            for (const t of st.common.tags) {
              if (!w.tags.includes(t)) w.tags.push(t);
            }
          }
          w.lastAuditedAt = new Date().toISOString();
          saveWalletsDb(db);
        }
      } catch (err) {
        console.warn(`[audit] Failed portfolio.stats for ${w.address}: ${err.message}`);
      }
    }
  } else {
    console.log(`[audit] No new candidates needed GMGN portfolio.stats enrichment this run.`);
  }

  saveWalletsDb(db);
  return { db, newlyAuditedAddresses: [...newlyAuditedSet] };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const maxStats = process.argv[2] ? Number(process.argv[2]) : 12;
  runAuditWallets({ maxStatsCalls: maxStats, onlyUnaudited: true }).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
