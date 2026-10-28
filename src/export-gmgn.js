import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { deriveMetrics } from "./filter-wallets.js";
import { OUTPUT_DIR, loadSeededTokens, loadWalletsDb, writeJsonAtomic } from "./limiter.js";
import { formatCompactUsd } from "./score-wallets.js";

export function toGmgnImportEntry(w, shortName) {
  const sr = w.scoreResult;
  const cleanName = shortName || String(sr.label || "")
    .replace(/^[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE00}-\u{FE0F}]+\s*/u, "")
    .replace(/[^a-zA-Z0-9_-]/g, "")
    .slice(0, 20);
  return {
    address: w.address,
    name: cleanName,
    emoji: sr.emoji,
    groups: ["default"],
  };
}

export function toGmgnTextLines(entries) {
  return entries.map((e) => `${e.address}:${e.name},`).join("\n") + "\n";
}

export function toDetailedReportEntry(w, shortName) {
  const m = w.filterResult?.metrics || deriveMetrics(w);
  const sr = w.scoreResult;
  return {
    address: w.address,
    shortName: shortName || w.shortName || sr.tier,
    tier: sr.tier,
    emoji: sr.emoji,
    score: sr.score,
    label: sr.label,
    group: sr.group,
    status: w.status || "active",
    firstQualifiedAt: w.firstQualifiedAt || null,
    lastAuditedAt: w.lastAuditedAt || null,
    winrate: Number((m.winrate * 100).toFixed(1)),
    winrateSource: m.winrateSource,
    realizedProfit7dUsd: m.p7,
    realizedProfit30dUsd: m.p30,
    totalRealizedProfitUsd: m.pAll,
    roi7dPct: Number((m.roi7 * 100).toFixed(2)),
    roi30dPct: Number((m.roi30 * 100).toFixed(2)),
    trades7d: m.trades7d,
    tokensTraded7d: m.tokenNum7d,
    solBalance: m.solBalance,
    daysSinceLastTx: m.daysSinceLastTx,
    txPerHourRecent: m.txPerHourRecent,
    sameSlotBurstRatio: m.sameSlotBurstRatio,
    failedTxRatio: m.failedTxRatio,
    tags: w.tags || [],
    sources: w.sources || [],
    observedLowcapTokens: Object.values(w.observedTokens || {}).map((t) => ({
      symbol: t.symbol,
      profitUsd: t.profit,
    })),
    scoreBreakdown: sr.breakdown,
  };
}

export function getActiveQualifiedCounts(db) {
  const qualified = Object.values(db.wallets || {}).filter(
    (w) => w.scoreResult?.qualified && w.status !== "pruned"
  );
  const counts = {
    total: qualified.length,
    S: qualified.filter((w) => w.scoreResult.tier === "S").length,
    A: qualified.filter((w) => w.scoreResult.tier === "A").length,
    B: qualified.filter((w) => w.scoreResult.tier === "B").length,
    C: qualified.filter((w) => w.scoreResult.tier === "C").length,
  };
  return counts;
}

export async function runExportGmgn() {
  console.log("=== [Step 6] Exporting GMGN Bulk Import JSONs & Summary Report ===");
  const db = loadWalletsDb();
  const seeded = loadSeededTokens();

  const allWallets = Object.values(db.wallets);
  const qualified = allWallets
    .filter((w) => w.scoreResult?.qualified && w.status !== "pruned")
    .sort((a, b) => (b.scoreResult?.score || 0) - (a.scoreResult?.score || 0));

  const prunedCount = allWallets.filter((w) => w.status === "pruned").length;

  const byTier = {
    S: qualified.filter((w) => w.scoreResult.tier === "S"),
    A: qualified.filter((w) => w.scoreResult.tier === "A"),
    B: qualified.filter((w) => w.scoreResult.tier === "B"),
    C: qualified.filter((w) => w.scoreResult.tier === "C"),
  };

  const shortNameMap = new Map();
  for (const tier of ["S", "A", "B", "C"]) {
    byTier[tier].forEach((w, idx) => {
      shortNameMap.set(w.address, `${tier}${idx + 1}`);
    });
  }

  const files = {
    all: path.join(OUTPUT_DIR, "gmgn_import_all.json"),
    S: path.join(OUTPUT_DIR, "gmgn_import_S.json"),
    A: path.join(OUTPUT_DIR, "gmgn_import_A.json"),
    B: path.join(OUTPUT_DIR, "gmgn_import_B.json"),
    C: path.join(OUTPUT_DIR, "gmgn_import_C.json"),
    allTxt: path.join(OUTPUT_DIR, "gmgn_import_all.txt"),
    STxt: path.join(OUTPUT_DIR, "gmgn_import_S.txt"),
    ATxt: path.join(OUTPUT_DIR, "gmgn_import_A.txt"),
    BTxt: path.join(OUTPUT_DIR, "gmgn_import_B.txt"),
    CTxt: path.join(OUTPUT_DIR, "gmgn_import_C.txt"),
    report: path.join(OUTPUT_DIR, "wallets_report.json"),
    summary: path.join(OUTPUT_DIR, "SUMMARY.md"),
  };

  const entriesAll = qualified.map((w) => toGmgnImportEntry(w, shortNameMap.get(w.address)));
  const entriesS = byTier.S.map((w) => toGmgnImportEntry(w, shortNameMap.get(w.address)));
  const entriesA = byTier.A.map((w) => toGmgnImportEntry(w, shortNameMap.get(w.address)));
  const entriesB = byTier.B.map((w) => toGmgnImportEntry(w, shortNameMap.get(w.address)));
  const entriesC = byTier.C.map((w) => toGmgnImportEntry(w, shortNameMap.get(w.address)));

  writeJsonAtomic(files.all, entriesAll);
  writeJsonAtomic(files.S, entriesS);
  writeJsonAtomic(files.A, entriesA);
  writeJsonAtomic(files.B, entriesB);
  writeJsonAtomic(files.C, entriesC);

  fs.writeFileSync(files.allTxt, toGmgnTextLines(entriesAll), "utf8");
  fs.writeFileSync(files.STxt, toGmgnTextLines(entriesS), "utf8");
  fs.writeFileSync(files.ATxt, toGmgnTextLines(entriesA), "utf8");
  fs.writeFileSync(files.BTxt, toGmgnTextLines(entriesB), "utf8");
  fs.writeFileSync(files.CTxt, toGmgnTextLines(entriesC), "utf8");

  const detailed = qualified.map((w) => toDetailedReportEntry(w, shortNameMap.get(w.address)));
  writeJsonAtomic(files.report, {
    generatedAt: new Date().toISOString(),
    seededTokensCount: (seeded.tokens || []).length,
    totalCandidateWallets: allWallets.length,
    totalQualifiedWallets: qualified.length,
    prunedWalletsCount: prunedCount,
    tierCounts: {
      S: byTier.S.length,
      A: byTier.A.length,
      B: byTier.B.length,
      C: byTier.C.length,
    },
    wallets: detailed,
  });

  const lines = [
    "# Solana Lowcap Smart Wallet Hunter — Master Audit Report",
    "",
    `- **Generated At (UTC)**: ${new Date().toISOString()}`,
    `- **Seeded Lowcap Tokens**: ${(seeded.tokens || []).length}`,
    `- **Total Candidate Wallets in Master DB**: ${allWallets.length}`,
    `- **Total Active Qualified Wallets**: ${qualified.length} (Pruned: ${prunedCount})`,
    `  - 🏆 **Tier S (Score >= 80)**: ${byTier.S.length}`,
    `  - 🔥 **Tier A (Score 65–79)**: ${byTier.A.length}`,
    `  - ⚡ **Tier B (Score 50–64)**: ${byTier.B.length}`,
    `  - 👀 **Tier C (Score 35–49)**: ${byTier.C.length}`,
    "",
    "## Top 25 Active Qualified Lowcap Wallets",
    "",
    "| Rank | Tier | Label | Wallet Address | Score | Winrate | 7d Realized PnL | 30d Realized PnL | 7d ROI | 7d Tokens | SOL Bal |",
    "| :--- | :---: | :--- | :--- | :---: | :---: | :--- | :---: | :---: | :---: | :---: |",
  ];

  detailed.slice(0, 25).forEach((w, idx) => {
    lines.push(
      `| ${idx + 1} | ${w.emoji} **${w.tier}** | \`${w.label}\` | \`${w.address}\` | **${w.score}** | ${w.winrate}% | ${formatCompactUsd(w.realizedProfit7dUsd)} | ${formatCompactUsd(w.realizedProfit30dUsd)} | ${w.roi7dPct}% | ${w.tokensTraded7d} | ${w.solBalance} SOL |`
    );
  });

  lines.push("");
  lines.push("## Exported GMGN Bulk-Import Files");
  lines.push("- `gmgn_import_all.json` (" + qualified.length + " wallets)");
  lines.push("- `gmgn_import_S.json` (" + byTier.S.length + " wallets)");
  lines.push("- `gmgn_import_A.json` (" + byTier.A.length + " wallets)");
  lines.push("- `gmgn_import_B.json` (" + byTier.B.length + " wallets)");
  lines.push("- `gmgn_import_C.json` (" + byTier.C.length + " wallets)");
  lines.push("");

  fs.writeFileSync(files.summary, lines.join("\n"), "utf8");

  console.log(`[export] Wrote 5 GMGN import files + wallets_report.json + SUMMARY.md to ${OUTPUT_DIR}`);
  console.log(
    `[export] Active Counts -> Total: ${qualified.length} | S: ${byTier.S.length} | A: ${byTier.A.length} | B: ${byTier.B.length} | C: ${byTier.C.length}`
  );
  return {
    files,
    counts: {
      total: qualified.length,
      all: qualified.length,
      S: byTier.S.length,
      A: byTier.A.length,
      B: byTier.B.length,
      C: byTier.C.length,
    },
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runExportGmgn().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
