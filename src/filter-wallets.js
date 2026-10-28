import { fileURLToPath } from "node:url";
import { loadWalletsDb, saveWalletsDb } from "./limiter.js";

const BOT_TAGS = new Set(["arbitrager", "mev_bot", "dex_bot", "scammer", "phishing"]);
const BAD_MAKER_TAGS = new Set(["creator", "dev_team", "bundler", "rat_trader", "dex_bot"]);

export function deriveMetrics(w) {
  const p7 = w.profits7d?.realizedProfit ?? 0;
  const p30 = w.profits30d?.realizedProfit ?? 0;
  const pAll = w.profits7d?.totalRealizedProfit ?? w.profits30d?.totalRealizedProfit ?? 0;
  const roi7 = w.profits7d?.roi ?? 0;
  const roi30 = w.profits30d?.roi ?? 0;
  const buy7 = w.profits7d?.buy ?? 0;
  const sell7 = w.profits7d?.sell ?? 0;
  const buy30 = w.profits30d?.buy ?? 0;
  const sell30 = w.profits30d?.sell ?? 0;
  const trades7d = buy7 + sell7;
  const trades30d = buy30 + sell30;

  const observedList = Object.values(w.observedTokens || {});
  const observedCount = observedList.length;

  let winrate = null;
  let winrateSource = "estimated";
  if (w.stats7d && typeof w.stats7d.winrate === "number" && w.stats7d.tokenNum > 0) {
    winrate = Number(w.stats7d.winrate.toFixed(4));
    winrateSource = "gmgn_stats_7d";
  } else {
    const baseRoi = Math.max(roi7, roi30);
    if (baseRoi > 0) {
      const winsObs = observedList.filter((t) => (t.profit || 0) > 50).length;
      const est = Math.min(0.74, Math.max(0.38, 0.44 + Math.tanh(baseRoi * 3.2) * 0.22 + Math.min(winsObs, 4) * 0.02));
      winrate = Number(est.toFixed(4));
    } else {
      winrate = 0;
    }
  }

  const tokenNum7d =
    w.stats7d?.tokenNum != null && w.stats7d.tokenNum > 0
      ? w.stats7d.tokenNum
      : Math.max(observedCount, Math.min(120, Math.round(buy7 / 2.5)));

  const avgHoldSec = w.stats7d?.avgHoldingPeriodSec ?? null;
  const daysSinceLastTx = w.helius?.daysSinceLastTx ?? 0.5;
  const txPerHourRecent = w.helius?.txPerHourRecent ?? 0;
  const sameSlotBurstRatio = w.helius?.sameSlotBurstRatio ?? 0;
  const failedTxRatio = w.helius?.failedTxRatio ?? 0;
  const solBalance = w.helius?.solBalance ?? w.nativeBalanceSol ?? 0;

  return {
    p7,
    p30,
    pAll,
    roi7,
    roi30,
    buy7,
    sell7,
    trades7d,
    trades30d,
    winrate,
    winrateSource,
    tokenNum7d,
    observedCount,
    avgHoldSec,
    daysSinceLastTx,
    txPerHourRecent,
    sameSlotBurstRatio,
    failedTxRatio,
    solBalance,
  };
}

export function evaluateWalletFilter(w) {
  const m = deriveMetrics(w);
  const reasons = [];

  if ((w.tags || []).some((t) => BOT_TAGS.has(t))) {
    reasons.push("TAG_MEV_OR_ARB_BOT");
  }
  if ((w.makerTokenTags || []).some((t) => BAD_MAKER_TAGS.has(t))) {
    reasons.push("TAG_DEV_OR_BUNDLER");
  }

  if (m.trades7d > 2200) {
    reasons.push(`HFT_EXCESSIVE_SWAPS_7D(${m.trades7d})`);
  }
  if (m.txPerHourRecent > 85 && m.sameSlotBurstRatio > 0.25) {
    reasons.push(`HELIUS_HFT_VELOCITY(${m.txPerHourRecent}/hr)`);
  }
  if (m.sameSlotBurstRatio > 0.45) {
    reasons.push(`ATOMIC_BUNDLE_BOT(sameSlot=${(m.sameSlotBurstRatio * 100).toFixed(0)}%)`);
  }
  if (m.failedTxRatio > 0.42) {
    reasons.push(`SPAM_SNIPER_FAILED_TX(${(m.failedTxRatio * 100).toFixed(0)}%)`);
  }
  if (m.avgHoldSec !== null && m.avgHoldSec > 0 && m.avgHoldSec < 25) {
    reasons.push(`FLASH_DUMPER_HOLD(${m.avgHoldSec.toFixed(0)}s)`);
  }

  if (m.daysSinceLastTx > 7) {
    reasons.push(`INACTIVE_OVER_7D(${m.daysSinceLastTx.toFixed(1)}d)`);
  }
  if (m.trades7d < 2 && m.trades30d < 4) {
    reasons.push("INSUFFICIENT_TRADES");
  }

  const bestPeriodProfit = Math.max(m.p7, m.p30);
  if (m.p7 <= 0 && m.p30 <= 0) {
    reasons.push(`UNPROFITABLE(7d=$${m.p7.toFixed(0)},30d=$${m.p30.toFixed(0)})`);
  } else if (bestPeriodProfit < 200) {
    reasons.push(`LOW_PROFIT($${bestPeriodProfit.toFixed(0)}<$200)`);
  }
  if (m.p7 < -1500) {
    reasons.push(`RECENT_DRAWDOWN_7D($${m.p7.toFixed(0)})`);
  }
  if (m.winrate < 0.35) {
    reasons.push(`LOW_WINRATE(${(m.winrate * 100).toFixed(1)}%<35%)`);
  }

  if (m.tokenNum7d < 2) {
    reasons.push("SINGLE_TOKEN_FLUKE");
  }

  return {
    passed: reasons.length === 0,
    reasons,
    metrics: m,
    filteredAt: new Date().toISOString(),
  };
}

export async function runFilterWallets(options = {}) {
  const { preserveExistingQualified = false } = options;
  console.log("=== [Step 4] Running Smart Multi-Layer Filtering ===");
  const db = loadWalletsDb();
  let passedCount = 0;
  let rejectedCount = 0;
  let preservedCount = 0;
  const rejectionBreakdown = {};

  for (const w of Object.values(db.wallets)) {
    if (w.status === "pruned") {
      rejectedCount++;
      rejectionBreakdown.PRUNED_EARLIER = (rejectionBreakdown.PRUNED_EARLIER || 0) + 1;
      continue;
    }
    if (preserveExistingQualified && w.scoreResult?.qualified && w.firstQualifiedAt) {
      preservedCount++;
      passedCount++;
      continue;
    }
    const res = evaluateWalletFilter(w);
    w.filterResult = res;
    if (res.passed) {
      passedCount++;
    } else {
      rejectedCount++;
      const primary = res.reasons[0] ? res.reasons[0].split("(")[0] : "OTHER";
      rejectionBreakdown[primary] = (rejectionBreakdown[primary] || 0) + 1;
    }
  }

  saveWalletsDb(db);
  console.log(`[filter] Passed: ${passedCount} (Preserved existing: ${preservedCount}) | Rejected: ${rejectedCount}`);
  console.log(`[filter] Rejection breakdown:`, rejectionBreakdown);
  return db;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runFilterWallets().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
