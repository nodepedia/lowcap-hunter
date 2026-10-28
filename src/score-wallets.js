import { fileURLToPath } from "node:url";
import { deriveMetrics, evaluateWalletFilter } from "./filter-wallets.js";
import { loadWalletsDb, saveWalletsDb } from "./limiter.js";

function clamp(val, min, max) {
  return Math.max(min, Math.min(max, val));
}

export function formatCompactUsd(amount) {
  const abs = Math.abs(Number(amount || 0));
  if (abs >= 1e6) return `$${(abs / 1e6).toFixed(1)}M`;
  if (abs >= 10000) return `$${Math.round(abs / 1000)}k`;
  if (abs >= 1000) return `$${(abs / 1000).toFixed(1)}k`;
  return `$${Math.round(abs)}`;
}

export function computeWalletScore(w) {
  const filter = w.filterResult || evaluateWalletFilter(w);
  if (!filter.passed) {
    return {
      qualified: false,
      tier: "REJECTED",
      emoji: "❌",
      score: 0,
      breakdown: {},
      reasons: filter.reasons,
    };
  }

  const m = filter.metrics || deriveMetrics(w);

  // 1. Winrate Score (0 - 28 pts)
  const wrNorm = clamp((m.winrate - 0.35) / (0.66 - 0.35), 0, 1);
  const winrateScore = Number((wrNorm * 28).toFixed(2));

  // 2. Realized Profit Score (0 - 26 pts)
  const effectiveProfit = Math.max(
    m.p7,
    m.p30 * 0.8,
    Math.min(m.pAll * 0.25, 30000)
  );
  const profitLog = clamp((Math.log10(Math.max(effectiveProfit, 100)) - 2.0) / (4.25 - 2.0), 0, 1);
  const profitScore = Number((profitLog * 26).toFixed(2));

  // 3. ROI & Multi-Bagger Efficiency Score (0 - 18 pts)
  const bestRoi = Math.max(m.roi7, m.roi30);
  let roiScore = clamp(Math.sqrt(clamp(bestRoi, 0, 0.45) / 0.45) * 16, 2, 16);
  const multiBaggers = (w.stats7d?.pnl2xTo5x || 0) + (w.stats7d?.pnlGt5x || 0) * 2;
  if (multiBaggers > 0) {
    roiScore = clamp(roiScore + Math.min(multiBaggers * 0.8, 3), 0, 18);
  }
  roiScore = Number(roiScore.toFixed(2));

  // 4. Consistency & Token Breadth Score (0 - 16 pts)
  let consistencyScore = 2;
  if (m.tokenNum7d >= 8 && m.tokenNum7d <= 200) {
    consistencyScore += 8;
  } else if (m.tokenNum7d >= 4 && m.tokenNum7d < 8) {
    consistencyScore += 6;
  } else if (m.tokenNum7d > 200 && m.tokenNum7d <= 350) {
    consistencyScore += 5;
  } else if (m.tokenNum7d >= 2) {
    consistencyScore += 2;
  }
  if (m.p7 > 500 && m.p30 >= m.p7) {
    consistencyScore += 3.5;
  }
  if (m.observedCount >= 2) {
    consistencyScore += Math.min(m.observedCount * 1.5, 2.5);
  }
  consistencyScore = Number(clamp(consistencyScore, 0, 16).toFixed(2));

  // 5. On-Chain Health, Recency & Smart Money Signals (0 - 12 pts)
  let onchainScore = 3;
  if (m.daysSinceLastTx <= 1.0) onchainScore += 2.5;
  else if (m.daysSinceLastTx <= 3.0) onchainScore += 1.5;

  if (m.solBalance >= 5.0) onchainScore += 2.5;
  else if (m.solBalance >= 0.5) onchainScore += 1.2;

  if ((w.tags || []).includes("smart_degen") || (w.tags || []).includes("kol") || (w.tags || []).includes("renowned")) {
    onchainScore += 2.5;
  }
  if (m.winrateSource === "gmgn_stats_7d") {
    onchainScore += 2.0;
  }
  if (m.failedTxRatio <= 0.12 && m.sameSlotBurstRatio <= 0.15) {
    onchainScore += 1.0;
  }
  onchainScore = Number(clamp(onchainScore, 0, 12).toFixed(2));

  let totalScore = Number(
    clamp(winrateScore + profitScore + roiScore + consistencyScore + onchainScore, 0, 100).toFixed(1)
  );

  if (m.tokenNum7d < 4 && totalScore >= 80) {
    totalScore = 78.5;
  }

  let tier = "C";
  let emoji = "👀";
  if (totalScore >= 80) {
    tier = "S";
    emoji = "🏆";
  } else if (totalScore >= 65) {
    tier = "A";
    emoji = "🔥";
  } else if (totalScore >= 50) {
    tier = "B";
    emoji = "⚡";
  } else if (totalScore >= 35) {
    tier = "C";
    emoji = "👀";
  } else {
    return {
      qualified: false,
      tier: "BELOW_C",
      emoji: "❌",
      score: totalScore,
      breakdown: { winrateScore, profitScore, roiScore, consistencyScore, onchainScore },
      reasons: [`SCORE_BELOW_35(${totalScore})`],
    };
  }

  const wrPct = Math.round(m.winrate * 100);
  const bestProfitDisplay = formatCompactUsd(Math.max(m.p7, m.p30));
  const shortAddr = w.address.slice(0, 4);
  const gmgnLabel = `${tier}_WR${wrPct}_${bestProfitDisplay}_${shortAddr}`;

  return {
    qualified: true,
    tier,
    emoji,
    score: totalScore,
    label: gmgnLabel,
    group: `Lowcap_${tier}`,
    breakdown: {
      winrateScore,
      profitScore,
      roiScore,
      consistencyScore,
      onchainScore,
    },
    scoredAt: new Date().toISOString(),
  };
}

export async function runScoreWallets(options = {}) {
  const { preserveExistingQualified = false } = options;
  console.log("=== [Step 5] Scoring & Tiering Wallets (S / A / B / C) ===");
  const db = loadWalletsDb();
  const counts = { S: 0, A: 0, B: 0, C: 0, REJECTED: 0 };
  const nowIso = new Date().toISOString();

  for (const w of Object.values(db.wallets)) {
    if (w.status === "pruned") {
      counts.REJECTED++;
      continue;
    }
    if (preserveExistingQualified && w.scoreResult?.qualified && w.firstQualifiedAt) {
      w.status = "active";
      counts[w.scoreResult.tier] = (counts[w.scoreResult.tier] || 0) + 1;
      continue;
    }

    const res = computeWalletScore(w);
    w.scoreResult = res;
    if (res.qualified) {
      w.status = "active";
      w.firstQualifiedAt = w.firstQualifiedAt || nowIso;
      w.lastAuditedAt = w.lastAuditedAt || nowIso;
      counts[res.tier] = (counts[res.tier] || 0) + 1;
    } else {
      counts.REJECTED++;
    }
  }

  saveWalletsDb(db);
  console.log(
    `[score] Tier distribution -> 🏆S: ${counts.S} | 🔥A: ${counts.A} | ⚡B: ${counts.B} | 👀C: ${counts.C} | Excluded/Pruned: ${counts.REJECTED}`
  );
  return db;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runScoreWallets().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
