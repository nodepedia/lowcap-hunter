// Sync tracked wallets to a separate private git repo (deduped by address).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import "dotenv/config";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUTPUT_DIR = path.join(ROOT, "output");
const DATA_DIR = path.join(ROOT, "data");
const EMOJI = { S: "🏆", A: "🥇", B: "🥈", C: "🥉" };

export function repoDir() {
  return (process.env.WALLETS_REPO_DIR || path.join(os.homedir(), "lowcap-wallets")).replace(/^~(?=\/|$)/, os.homedir());
}

function repoUrl() {
  const url = process.env.WALLETS_REPO_URL;
  const tok = process.env.WALLETS_REPO_TOKEN;
  if (url && tok && url.startsWith("https://")) return url.replace("https://", `https://x-access-token:${tok}@`);
  return url;
}

const normAddr = (a) => (typeof a === "string" ? a.trim() : "");

/** Merge incoming wallet records into existing; one record per address. Pure. */
export function mergeWallets(existing = [], incoming = [], now = new Date().toISOString()) {
  const map = new Map();
  for (const w of existing) {
    const a = normAddr(w?.address);
    if (a) map.set(a, { ...map.get(a), ...w, address: a });
  }
  for (const w of incoming) {
    const a = normAddr(w?.address);
    if (!a) continue;
    const prev = map.get(a);
    const firstSeenAt = prev?.firstSeenAt || w.firstSeenAt || w.firstQualifiedAt || now;
    map.set(a, { ...prev, ...w, address: a, firstSeenAt, lastSeenAt: now });
  }
  return [...map.values()].sort((x, y) => (x.address < y.address ? -1 : x.address > y.address ? 1 : 0));
}

export function gmgnImport(wallets, tier) {
  return wallets
    .filter((w) => w.tier === tier && (w.status ?? "active") === "active")
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0) || (a.address < b.address ? -1 : 1))
    .map((w, i) => ({ address: w.address, name: `${tier}${i + 1}`, emoji: EMOJI[tier], groups: ["default"] }));
}

const readJson = (p, d) => { try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return d; } };
const writeJson = (p, v) => fs.writeFileSync(p, JSON.stringify(v, null, 2) + "\n");
const git = (args, cwd) => execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] }).toString().trim();

function ensureRepo(dir) {
  if (fs.existsSync(path.join(dir, ".git"))) {
    git(["pull", "--rebase", "--quiet"], dir);
  } else {
    const url = repoUrl();
    if (!url) throw new Error("WALLETS_REPO_URL not set and repo dir missing");
    git(["clone", "--quiet", url, dir]);
  }
}

function localWallets() {
  const report = readJson(path.join(OUTPUT_DIR, "wallets_report.json"), {});
  return Array.isArray(report.wallets) ? report.wallets : [];
}

function writeFiles(dir, incoming) {
  const existing = readJson(path.join(dir, "wallets.json"), { wallets: [] }).wallets || [];
  const merged = mergeWallets(existing, incoming);
  writeJson(path.join(dir, "wallets.json"), { count: merged.length, wallets: merged });
  writeJson(path.join(dir, "gmgn_import_S.json"), gmgnImport(merged, "S"));
  writeJson(path.join(dir, "gmgn_import_A.json"), gmgnImport(merged, "A"));
  return merged;
}

/** Never throws; returns true on success. */
export async function syncWallets() {
  if (!process.env.WALLETS_REPO_URL && !process.env.WALLETS_REPO_DIR) return false;
  const dir = repoDir();
  try {
    ensureRepo(dir);
    const incoming = localWallets();
    for (let attempt = 0; attempt < 3; attempt++) {
      const merged = writeFiles(dir, incoming);
      git(["add", "wallets.json", "gmgn_import_S.json", "gmgn_import_A.json"], dir);
      if (!git(["status", "--porcelain"], dir)) { console.log(`[sync] no changes (${merged.length} wallets)`); return true; }
      git(["-c", "user.name=lowcap-hunter", "-c", "user.email=bot@lowcap-hunter", "commit", "-qm", `sync: ${merged.length} wallets`], dir);
      try { git(["push", "--quiet"], dir); console.log(`[sync] pushed ${merged.length} wallets`); return true; }
      catch {
        git(["reset", "--hard", "-q", "HEAD~1"], dir);
        git(["pull", "--rebase", "--quiet"], dir);
      }
    }
    throw new Error("push failed after retries");
  } catch (err) {
    console.warn(`[sync] WARN wallet sync failed: ${err.message.split("\n")[0]}`);
    return false;
  }
}

export function restoreWallets() {
  const dir = repoDir();
  ensureRepo(dir);
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  const { wallets = [] } = readJson(path.join(dir, "wallets.json"), {});
  for (const f of ["gmgn_import_S.json", "gmgn_import_A.json"]) fs.copyFileSync(path.join(dir, f), path.join(OUTPUT_DIR, f));
  const reportPath = path.join(OUTPUT_DIR, "wallets_report.json");
  if (!fs.existsSync(reportPath)) writeJson(reportPath, { restoredAt: new Date().toISOString(), wallets });
  const dbPath = path.join(DATA_DIR, "wallets-db.json");
  if (!fs.existsSync(dbPath)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    writeJson(dbPath, { updatedAt: null, wallets: Object.fromEntries(wallets.map((w) => [w.address, w])) });
  }
  console.log(`[restore] ${wallets.length} wallets restored from ${dir}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes("--restore")) restoreWallets();
  else await syncWallets();
}
