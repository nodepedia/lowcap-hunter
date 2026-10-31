import path from "node:path";
import { runSeedTokens } from "./seed-tokens.js";
import { runHarvestWallets } from "./harvest-wallets.js";
import { runAuditWallets } from "./audit-wallets.js";
import { runFilterWallets } from "./filter-wallets.js";
import { runScoreWallets } from "./score-wallets.js";
import {
  getActiveQualifiedCounts,
  runExportGmgn,
  toDetailedReportEntry,
} from "./export-gmgn.js";
import { runReauditWallets } from "./reaudit-wallets.js";
import { syncWallets } from "./sync-wallets.js";
import { computeMeteoraLpOverlap } from "./meteora-overlap.js";
import {
  OUTPUT_DIR,
  loadSeededTokens,
  loadWalletsDb,
  saveWalletsDb,
  sleep,
  writeJsonAtomic,
} from "./limiter.js";

const args = process.argv.slice(2);
const isDaemon = args.includes("--daemon");
const isReaudit = args.includes("--reaudit");
const isHarvest = args.includes("--harvest") || (!isDaemon && !isReaudit);
const isFast = args.includes("--fast") || args.includes("--cached");

const CYCLE_INTERVAL_MIN = Number(process.env.HUNTER_CYCLE_MIN || 45);
const HARVEST_TOKENS_PER_CYCLE = Number(process.env.HARVEST_TOKENS_PER_CYCLE || 6);
const STATS_CALLS_PER_CYCLE = Number(process.env.STATS_CALLS_PER_CYCLE || 12);

export function backfillQualifiedTimestamps() {
  const db = loadWalletsDb();
  let updated = 0;
  const fallbackIso = db.updatedAt || new Date().toISOString();

  for (const w of Object.values(db.wallets || {})) {
    const auditTs =
      w.lastAuditedAt ||
      w.stats7d?.auditedAt ||
      w.helius?.auditedAt ||
      w.profits7d?.auditedAt ||
      w.profits30d?.auditedAt ||
      fallbackIso;

    if (w.profits7d && !w.lastAuditedAt) {
      w.lastAuditedAt = auditTs;
      updated++;
    }
    if (w.scoreResult?.qualified && w.status !== "pruned") {
      if (!w.firstQualifiedAt) {
        w.firstQualifiedAt = w.scoreResult.scoredAt || w.firstSeenAt || fallbackIso;
        updated++;
      }
      if (!w.status) {
        w.status = "active";
        updated++;
      }
    }
  }

  if (updated > 0) {
    saveWalletsDb(db);
    console.log(`[backfill] Backfilled timestamps/status on ${updated} fields in wallets-db.json.`);
  }
  return db;
}

export async function runDailyHarvest(options = {}) {
  const startMs = Date.now();
  const harvestTokensLimit = options.harvestTokensLimit ?? (isFast ? 0 : HARVEST_TOKENS_PER_CYCLE);
  const statsCallsLimit = options.statsCallsLimit ?? (isFast ? 0 : STATS_CALLS_PER_CYCLE);
  const skipGmgnTrending = options.skipGmgnTrending ?? isFast;

  console.log(`\n================================================================`);
  console.log(`[lowcap-hunter] Starting Cumulative Daily Harvest at ${new Date().toISOString()}`);
  console.log(`================================================================`);

  // 1. Backfill & Snapshot current qualified state before running
  const dbBefore = backfillQualifiedTimestamps();
  const beforeCounts = getActiveQualifiedCounts(dbBefore);
  const prevQualifiedMap = {};
  for (const w of Object.values(dbBefore.wallets || {})) {
    if (w.scoreResult?.qualified && w.status !== "pruned") {
      prevQualifiedMap[w.address] = {
        tier: w.scoreResult.tier,
        score: w.scoreResult.score,
        label: w.scoreResult.label,
      };
    }
  }
  console.log(
    `[harvest-mode] Snapshot before run -> Total: ${beforeCounts.total} (S:${beforeCounts.S}, A:${beforeCounts.A}, B:${beforeCounts.B}, C:${beforeCounts.C})`
  );

  // 2. Seed lowcap tokens & harvest candidate wallets
  await runSeedTokens({ skipGmgnTrending });
  await runHarvestWallets(harvestTokensLimit);

  // 3. Audit ONLY newly discovered / unaudited wallets (within 3-day window)
  await runAuditWallets({
    maxStatsCalls: statsCallsLimit,
    onlyUnaudited: true,
    maxAgeDays: 3,
  });

  // 4. Filter & Score newly audited wallets while preserving existing qualified wallets until 3-day re-audit
  await runFilterWallets({ preserveExistingQualified: true });
  await runScoreWallets({ preserveExistingQualified: true });

  // 5. Re-export the 5 cumulative GMGN JSON files + wallets_report.json + SUMMARY.md
  await runExportGmgn();

  // 6. Build structured latest_harvest_report.json
  const dbAfter = loadWalletsDb();
  const seeded = loadSeededTokens();
  const afterCounts = getActiveQualifiedCounts(dbAfter);
  const nowIso = new Date().toISOString();

  const newWalletsByTier = { S: [], A: [], B: [], C: [] };
  let newWalletsCount = 0;

  const activeQualifiedAfter = Object.values(dbAfter.wallets || {})
    .filter((w) => w.scoreResult?.qualified && w.status !== "pruned")
    .sort((a, b) => (b.scoreResult?.score || 0) - (a.scoreResult?.score || 0));

  for (const w of activeQualifiedAfter) {
    if (!prevQualifiedMap[w.address]) {
      w.firstQualifiedAt = w.firstQualifiedAt || nowIso;
      w.lastAuditedAt = w.lastAuditedAt || nowIso;
      w.status = "active";
      const det = toDetailedReportEntry(w);
      const tier = w.scoreResult.tier;
      if (newWalletsByTier[tier]) {
        newWalletsByTier[tier].push({
          address: det.address,
          tier: det.tier,
          score: det.score,
          label: det.label,
          winrate: det.winrate,
          realizedProfit7dUsd: det.realizedProfit7dUsd,
          realizedProfit30dUsd: det.realizedProfit30dUsd,
          roi7dPct: det.roi7dPct,
          tokensTraded7d: det.tokensTraded7d,
          solBalance: det.solBalance,
          observedLowcapTokens: det.observedLowcapTokens,
        });
        newWalletsCount++;
      }
    }
  }
  saveWalletsDb(dbAfter);

  const newRunners = (seeded.tokens || []).slice(0, 15).map((t) => ({
    symbol: t.symbol || "UNKNOWN",
    name: t.name || t.symbol || "",
    address: t.address,
    marketCapUsd: Number(t.marketCap || 0),
    volume24hUsd: Number(t.volume24h || 0),
    priceChange24hPct: Number(t.priceChange24hPct || 0),
  }));

  const meteoraLpOverlap = computeMeteoraLpOverlap(dbAfter);

  const harvestReport = {
    runAt: nowIso,
    beforeCounts,
    afterCounts,
    newRunners,
    newWalletsCount,
    newWalletsByTier,
    meteoraLpOverlap,
  };

  const reportPath = path.join(OUTPUT_DIR, "latest_harvest_report.json");
  writeJsonAtomic(reportPath, harvestReport);

  const elapsedSec = ((Date.now() - startMs) / 1000).toFixed(1);
  console.log(`================================================================`);
  console.log(
    `[lowcap-hunter] Daily Harvest completed in ${elapsedSec}s! Added ${newWalletsCount} new wallets. Total active: ${afterCounts.total}`
  );
  console.log(`================================================================\n`);
  return harvestReport;
}

async function main() {
  backfillQualifiedTimestamps();

  if (isReaudit) {
    await runReauditWallets();
    return;
  }

  if (isDaemon) {
    const db = loadWalletsDb();
    if (db.updatedAt && Date.now() - new Date(db.updatedAt).getTime() < 15 * 60 * 1000) {
      console.log(
        `[lowcap-hunter] Recent cycle already completed at ${db.updatedAt}. Sleeping ${CYCLE_INTERVAL_MIN}m before next cycle...`
      );
      await sleep(CYCLE_INTERVAL_MIN * 60 * 1000);
    }
    while (true) {
      try {
        await runDailyHarvest();
      } catch (err) {
        console.error(`[lowcap-hunter] Daemon cycle error:`, err);
      }
      await syncWallets();
      console.log(`[lowcap-hunter] Daemon sleeping for ${CYCLE_INTERVAL_MIN} minutes before next cycle...`);
      await sleep(CYCLE_INTERVAL_MIN * 60 * 1000);
    }
  } else if (isHarvest) {
    await runDailyHarvest();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
