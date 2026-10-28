import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  auditWalletSignaturesWithHelius,
  batchFetchSolBalances,
  isWalletRecentlyAudited,
  parseProfitItem,
} from "./audit-wallets.js";
import { getActiveQualifiedCounts, runExportGmgn } from "./export-gmgn.js";
import { deriveMetrics, evaluateWalletFilter } from "./filter-wallets.js";
import {
  OUTPUT_DIR,
  gmgnLimiter,
  loadWalletsDb,
  saveWalletsDb,
  sleep,
  writeJsonAtomic,
} from "./limiter.js";
import { computeWalletScore } from "./score-wallets.js";

const TIER_RANK = {
  S: 4,
  A: 3,
  B: 2,
  C: 1,
};

export async function runReauditWallets(options = {}) {
  const {
    force = process.argv.includes("--force"),
    cached = process.argv.includes("--cached"),
    maxAgeDays = 3,
    maxStatsCalls = 8,
  } = options;

  console.log(`\n================================================================`);
  console.log(`=== [3-Day Re-Audit & Pruning Mode] Starting at ${new Date().toISOString()} ===`);
  console.log(`=== Options: force=${force}, cached=${cached}, maxAgeDays=${maxAgeDays} ===`);
  console.log(`================================================================`);

  const db = loadWalletsDb();
  const beforeCounts = getActiveQualifiedCounts(db);

  const activeQualifiedWallets = Object.values(db.wallets || {}).filter(
    (w) => w.scoreResult?.qualified && w.status !== "pruned"
  );

  const prevQualified = {};
  for (const w of activeQualifiedWallets) {
    const m = w.filterResult?.metrics || deriveMetrics(w);
    prevQualified[w.address] = {
      address: w.address,
      tier: w.scoreResult.tier,
      score: w.scoreResult.score,
      label: w.scoreResult.label,
      winrate: Number((m.winrate * 100).toFixed(1)),
      realizedProfit7dUsd: m.p7,
      realizedProfit30dUsd: m.p30,
    };
  }

  console.log(
    `[reaudit] Snapshotted ${activeQualifiedWallets.length} active qualified wallets -> S:${beforeCounts.S} A:${beforeCounts.A} B:${beforeCounts.B} C:${beforeCounts.C}`
  );

  // Determine which active qualified wallets need fresh network re-audit
  const toNetworkAudit = cached
    ? []
    : activeQualifiedWallets.filter((w) => force || !isWalletRecentlyAudited(w, maxAgeDays));

  console.log(
    `[reaudit] Wallets scheduled for live network re-fetch: ${toNetworkAudit.length}/${activeQualifiedWallets.length}`
  );

  if (toNetworkAudit.length > 0) {
    const addresses = toNetworkAudit.map((w) => w.address);

    // 1. GMGN Batch 7d & 30d profits (100 per call)
    for (let i = 0; i < addresses.length; i += 100) {
      const batch = addresses.slice(i, i + 100);
      console.log(`[reaudit] Batch querying fresh 7d & 30d profits for ${batch.length} wallets...`);
      try {
        const res7d = await gmgnLimiter.call(
          `reaudit.profits(sol, 7d, ${batch.length} wallets)`,
          (client) => client.getWalletProfits("sol", batch, "7d")
        );
        for (const item of res7d?.list || []) {
          if (item.wallet_address && db.wallets[item.wallet_address]) {
            db.wallets[item.wallet_address].profits7d = parseProfitItem(item);
            db.wallets[item.wallet_address].lastAuditedAt = new Date().toISOString();
          }
        }
      } catch (err) {
        console.warn(`[reaudit] 7d batch profit error: ${err.message}`);
      }

      try {
        const res30d = await gmgnLimiter.call(
          `reaudit.profits(sol, 30d, ${batch.length} wallets)`,
          (client) => client.getWalletProfits("sol", batch, "30d")
        );
        for (const item of res30d?.list || []) {
          if (item.wallet_address && db.wallets[item.wallet_address]) {
            db.wallets[item.wallet_address].profits30d = parseProfitItem(item);
            db.wallets[item.wallet_address].lastAuditedAt = new Date().toISOString();
          }
        }
      } catch (err) {
        console.warn(`[reaudit] 30d batch profit error: ${err.message}`);
      }
      saveWalletsDb(db);
    }

    // 2. Helius RPC fresh balances & signature activity
    console.log(`[reaudit] Fetching fresh Helius SOL balances & tx activity for ${addresses.length} wallets...`);
    const balances = await batchFetchSolBalances(addresses);
    const concurrency = 2;
    for (let i = 0; i < toNetworkAudit.length; i += concurrency) {
      const slice = toNetworkAudit.slice(i, i + concurrency);
      await Promise.all(
        slice.map(async (w) => {
          try {
            const solBal = balances[w.address] ?? w.nativeBalanceSol ?? 0;
            const h = await auditWalletSignaturesWithHelius(w.address, solBal);
            w.helius = h;
            w.nativeBalanceSol = h.solBalance;
            w.lastAuditedAt = new Date().toISOString();
          } catch (err) {
            console.warn(`[reaudit] Helius warning for ${w.address.slice(0, 8)}: ${err.message}`);
          }
        })
      );
      await sleep(250);
    }
    saveWalletsDb(db);

    // 3. Optional GMGN 7d portfolio stats refresh for top candidates lacking stats7d
    const statsTargets = toNetworkAudit
      .filter((w) => !w.stats7d && (w.profits7d?.realizedProfit || 0) > 500)
      .slice(0, maxStatsCalls);

    for (const w of statsTargets) {
      try {
        const st = await gmgnLimiter.call(
          `reaudit.stats(sol, 7d, ${w.address.slice(0, 8)}...)`,
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
          w.lastAuditedAt = new Date().toISOString();
        }
      } catch (err) {
        console.warn(`[reaudit] stats warning for ${w.address}: ${err.message}`);
      }
    }
    saveWalletsDb(db);
  }

  // Re-evaluate filter and score on all previously qualified wallets
  const promoted = [];
  const retained = [];
  const demoted = [];
  const pruned = [];
  const nowIso = new Date().toISOString();

  for (const addr of Object.keys(prevQualified)) {
    const prev = prevQualified[addr];
    const w = db.wallets[addr];
    if (!w) continue;

    const filterRes = evaluateWalletFilter(w);
    w.filterResult = filterRes;
    const scoreRes = computeWalletScore(w);
    w.scoreResult = scoreRes;
    w.lastAuditedAt = w.lastAuditedAt || nowIso;

    const m = filterRes.metrics || deriveMetrics(w);
    const winratePct = Number((m.winrate * 100).toFixed(1));

    if (!filterRes.passed || !scoreRes.qualified) {
      w.status = "pruned";
      w.prunedAt = nowIso;
      w.prunedReasons = scoreRes.reasons?.length ? scoreRes.reasons : filterRes.reasons;
      pruned.push({
        address: addr,
        prevTier: prev.tier,
        prevScore: prev.score,
        prevLabel: prev.label,
        reasons: w.prunedReasons,
      });
      continue;
    }

    w.status = "active";
    w.prunedAt = null;
    w.prunedReasons = null;

    const prevRank = TIER_RANK[prev.tier] || 0;
    const newRank = TIER_RANK[scoreRes.tier] || 0;

    const transitionEntry = {
      address: addr,
      fromTier: prev.tier,
      toTier: scoreRes.tier,
      fromScore: prev.score,
      toScore: scoreRes.score,
      label: scoreRes.label,
      winrate: winratePct,
      pnl7d: m.p7,
      pnl30d: m.p30,
    };

    if (newRank > prevRank) {
      promoted.push(transitionEntry);
    } else if (newRank < prevRank) {
      demoted.push(transitionEntry);
    } else {
      retained.push(transitionEntry);
    }
  }

  promoted.sort((a, b) => b.toScore - a.toScore);
  demoted.sort((a, b) => b.toScore - a.toScore);
  retained.sort((a, b) => b.toScore - a.toScore);

  saveWalletsDb(db);
  await runExportGmgn();

  const afterCounts = getActiveQualifiedCounts(db);
  const report = {
    runAt: nowIso,
    mode: cached ? "cached" : force ? "force-live" : "scheduled-3d",
    beforeCounts,
    afterCounts,
    summary: {
      promotedCount: promoted.length,
      retainedCount: retained.length,
      demotedCount: demoted.length,
      prunedCount: pruned.length,
    },
    promoted,
    demoted,
    pruned,
    retainedSample: retained.slice(0, 10),
  };

  const reportPath = path.join(OUTPUT_DIR, "latest_reaudit_report.json");
  writeJsonAtomic(reportPath, report);
  console.log(`[reaudit] Wrote re-audit report to ${reportPath}`);
  console.log(`[reaudit] Summary:`, report.summary);
  return report;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runReauditWallets().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
