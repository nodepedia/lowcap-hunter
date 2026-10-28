import fs from "node:fs";
import path from "node:path";

export function computeMeteoraLpOverlap(db) {
  const wallets = Object.values(db?.wallets || {}).filter(
    (w) => w.scoreResult?.qualified && w.status !== "pruned"
  );
  const pools = [];
  const meteoraDirs = ["/root/grokbot/meteorabot-v3", "/workspace/meteorabot-v3", "/root/meteorabot-v3"];
  let meteoraDir = meteoraDirs.find((d) => fs.existsSync(path.join(d, "state.json"))) || meteoraDirs[0];
  try {
    const statePath = path.join(meteoraDir, "state.json");
    if (fs.existsSync(statePath)) {
      const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
      const positions = state.positions || {};
      for (const [poolAddr, pos] of Object.entries(positions)) {
        const baseMint = pos.tokenX?.mint || pos.baseMint || "";
        const symbol = pos.tokenX?.symbol || pos.pairName?.split("-")[0] || "UNKNOWN";
        const pair = pos.pairName || `${symbol}-SOL`;
        const matched = [];
        const tierBreakdown = { S: 0, A: 0, B: 0, C: 0 };
        let totalProfit = 0;
        for (const w of wallets) {
          const obs = w.observedTokens?.[baseMint] || w.observedTokens?.[symbol];
          if (obs) {
            const tier = w.scoreResult?.tier || "C";
            tierBreakdown[tier] = (tierBreakdown[tier] || 0) + 1;
            const p = Number(obs.profit || 0);
            totalProfit += p;
            matched.push({
              address: w.address,
              tier,
              score: w.scoreResult?.score || 0,
              label: w.scoreResult?.label || "",
              tokenProfitUsd: p,
              buyTxCount: obs.buyTxCount || 0,
              sellTxCount: obs.sellTxCount || 0,
            });
          }
        }
        matched.sort((a, b) => b.tokenProfitUsd - a.tokenProfitUsd);
        pools.push({
          pool: poolAddr,
          pair,
          symbol,
          baseMint,
          activePosition: true,
          smartWalletsCount: matched.length,
          tierBreakdown,
          totalRealizedProfitOnTokenUsd: Number(totalProfit.toFixed(2)),
          topWallets: matched.slice(0, 10),
        });
      }
    }
  } catch (err) {
    console.error("[meteora-overlap] warning:", err.message);
  }
  return {
    checkedAt: new Date().toISOString(),
    poolsCount: pools.length,
    poolsWithSmartMoney: pools.filter((p) => p.smartWalletsCount > 0).length,
    pools,
  };
}
