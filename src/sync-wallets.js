// Sync tracked wallets to a separate private git repo (deduped by address).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUTPUT_DIR = path.join(ROOT, "output");
const DATA_DIR = path.join(ROOT, "data");
dotenv.config({ path: path.join(ROOT, ".env"), quiet: true }); // load repo .env regardless of process cwd (PM2/systemd)
const EMOJI = { S: "🏆", A: "🥇", B: "🥈", C: "🥉" };

export function repoDir(env = process.env) {
  return (env.WALLETS_REPO_DIR || path.join(os.homedir(), "lowcap-wallets")).trim().replace(/^~(?=\/|$)/, os.homedir());
}

const DEFAULT_URL = "https://github.com/nodepedia/lowcap-wallets.git";
/** Token sanitized: strips whitespace/CR/LF and surrounding quotes. */
export function repoToken(env = process.env) {
  return (env.WALLETS_REPO_TOKEN || "").trim().replace(/^["']|["']$/g, "").trim();
}

/** Clean URL without credentials (strips any user[:pass]@ already in it). */
export function plainRepoUrl(env = process.env) {
  const url = (env.WALLETS_REPO_URL || "").trim() || (repoToken(env) ? DEFAULT_URL : "");
  return url.replace(/^https:\/\/[^/@]*@/, "https://");
}

export function repoUrl(env = process.env) {
  const url = plainRepoUrl(env), tok = repoToken(env);
  if (url && tok && url.startsWith("https://")) return url.replace("https://", `https://x-access-token:${encodeURIComponent(tok)}@`);
  return url;
}

/** owner/repo from URL (https or ssh). */
export function repoSlug(env = process.env) {
  const m = plainRepoUrl(env).match(/github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?\/?$/);
  return m ? `${m[1]}/${m[2]}` : "nodepedia/lowcap-wallets";
}

/** Remove any token / credentials from text. */
export function redact(text, env = process.env) {
  let t = String(text ?? "");
  const tok = repoToken(env);
  if (tok) { t = t.split(tok).join("***"); t = t.split(encodeURIComponent(tok)).join("***"); }
  return t.replace(/(https?:\/\/)[^/\s@]+@/g, "$1***@").replace(/\b(gh[pousr]_|github_pat_)[A-Za-z0-9_]+/g, "***");
}

/** Classify a git error message. */
export function classifyGitError(msg) {
  const m = String(msg || "");
  if (/Invalid username or (token|password)|Authentication failed|Password authentication is not supported|could not read (Username|Password)|terminal prompts disabled|returned error: 40[13]/i.test(m)) return "invalid_token";
  if (/Repository not found|not found|returned error: 404|does not appear to be a git repository|Permission to .* denied|access denied/i.test(m)) return "repo_not_found";
  if (/appear to have cloned an empty repository|couldn't find remote ref|no such ref was fetched|does not have any commits yet|unknown revision/i.test(m)) return "empty_repo";
  return "unknown";
}

const HINT = {
  invalid_token: "token invalid/expired or not sent (check WALLETS_REPO_TOKEN in lowcap-hunter/.env, needs Contents: read+write on the repo)",
  repo_not_found: "repo not found or token has no access to it (fine-grained PAT must include this repo)",
  empty_repo: "remote repo is empty",
  unknown: "git error",
};

export class GitError extends Error {
  constructor(args, stderr, code, env = process.env) {
    const clean = redact(stderr, env).trim();
    const kind = classifyGitError(clean);
    super(`git ${redact(args.join(" "), env)} failed (exit ${code}) [${kind}: ${HINT[kind]}]${clean ? `: ${clean}` : ""}`);
    this.kind = kind; this.code = code; this.stderr = clean;
  }
}

/** Default git runner. Disables credential helpers/prompts so only the URL token is used. */
export function realGit(args, cwd) {
  try {
    return execFileSync("git", ["-c", "credential.helper=", ...args], {
      cwd, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "echo" },
    }).toString().trim();
  } catch (e) {
    throw new GitError(args, `${e.stderr?.toString() || ""}${e.stdout?.toString() || ""}` || e.message, e.status ?? "?");
  }
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

/** Clone or pull. Empty remote = success (local repo on branch main). Returns "cloned"|"pulled"|"empty". */
export function ensureRepo(dir, { git = realGit, env = process.env } = {}) {
  if (fs.existsSync(path.join(dir, ".git"))) {
    try { git(["pull", "--rebase", "--quiet"], dir); return "pulled"; }
    catch (e) { if (e.kind === "empty_repo") return "empty"; throw e; }
  }
  const url = repoUrl(env);
  if (!url) throw new Error("WALLETS_REPO_URL/WALLETS_REPO_TOKEN not set and repo dir missing");
  if (url.startsWith("https://") && !repoToken(env)) throw Object.assign(new Error("WALLETS_REPO_TOKEN empty: HTTPS needs a PAT (or use an SSH URL)"), { kind: "invalid_token" });
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  const out = git(["clone", url, dir]);
  const empty = /empty repository/i.test(out || "") || !hasCommits(dir, git);
  if (empty) { try { git(["checkout", "-q", "-B", "main"], dir); } catch {} return "empty"; }
  return "cloned";
}

function hasCommits(dir, git) {
  try { git(["rev-parse", "--verify", "-q", "HEAD"], dir); return true; } catch { return false; }
}

function localWallets() {
  const report = readJson(path.join(OUTPUT_DIR, "wallets_report.json"), {});
  return Array.isArray(report.wallets) ? report.wallets : [];
}

/** Build file contents (pure). */
export function buildFiles(existing, incoming, now) {
  const merged = mergeWallets(existing, incoming, now);
  const ser = (v) => JSON.stringify(v, null, 2) + "\n";
  return { merged, files: {
    "wallets.json": ser({ count: merged.length, wallets: merged }),
    "gmgn_import_S.json": ser(gmgnImport(merged, "S")),
    "gmgn_import_A.json": ser(gmgnImport(merged, "A")),
  } };
}

function writeFiles(dir, incoming) {
  const existing = readJson(path.join(dir, "wallets.json"), { wallets: [] }).wallets || [];
  const { merged, files } = buildFiles(existing, incoming);
  for (const [f, c] of Object.entries(files)) fs.writeFileSync(path.join(dir, f), c);
  return merged;
}

async function syncViaGit(dir, incoming, { git, env }) {
  let state = ensureRepo(dir, { git, env });
  for (let attempt = 0; attempt < 3; attempt++) {
    const merged = writeFiles(dir, incoming);
    git(["add", "wallets.json", "gmgn_import_S.json", "gmgn_import_A.json"], dir);
    if (!git(["status", "--porcelain"], dir)) { console.log(`[sync] no changes (${merged.length} wallets)`); return true; }
    git(["-c", "user.name=lowcap-hunter", "-c", "user.email=bot@lowcap-hunter", "commit", "-qm", `sync: ${merged.length} wallets`], dir);
    try {
      git(state === "empty" ? ["push", "--quiet", "-u", "origin", "main"] : ["push", "--quiet"], dir);
      console.log(`[sync] pushed ${merged.length} wallets (git)`); return true;
    } catch (e) {
      if (e.kind === "invalid_token" || e.kind === "repo_not_found") throw e;
      if (state === "empty") throw e;
      git(["reset", "--hard", "-q", "HEAD~1"], dir);
      git(["pull", "--rebase", "--quiet"], dir);
    }
  }
  throw new Error("push failed after retries");
}

/** Fallback: GitHub Contents API. Never logs the token. */
export async function syncViaApi(incoming, { fetch: f = globalThis.fetch, env = process.env, now } = {}) {
  const tok = repoToken(env);
  if (!tok) throw new Error("API fallback needs WALLETS_REPO_TOKEN");
  const base = `https://api.github.com/repos/${repoSlug(env)}/contents/`;
  const headers = { Authorization: `Bearer ${tok}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "lowcap-hunter" };
  const fail = async (res, what) => { throw new Error(`API ${what} HTTP ${res.status}: ${redact((await res.text().catch(() => "")).slice(0, 200), env)}`); };
  const cur = {};
  for (const name of ["wallets.json", "gmgn_import_S.json", "gmgn_import_A.json"]) {
    const res = await f(base + name, { headers });
    if (res.status === 404) continue;
    if (!res.ok) await fail(res, `GET ${name}`);
    const j = await res.json();
    cur[name] = { sha: j.sha, text: Buffer.from(j.content || "", "base64").toString("utf8") };
  }
  let existing = [];
  try { existing = JSON.parse(cur["wallets.json"]?.text || "{}").wallets || []; } catch {}
  const { merged, files } = buildFiles(existing, incoming, now);
  let changed = 0;
  for (const [name, text] of Object.entries(files)) {
    if (cur[name]?.text === text) continue;
    const body = { message: `sync: ${merged.length} wallets`, content: Buffer.from(text).toString("base64"), branch: "main" };
    if (cur[name]?.sha) body.sha = cur[name].sha;
    const res = await f(base + name, { method: "PUT", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify(body) });
    if (!res.ok) await fail(res, `PUT ${name}`);
    changed++;
  }
  console.log(changed ? `[sync] pushed ${merged.length} wallets (api, ${changed} files)` : `[sync] no changes (${merged.length} wallets, api)`);
  return true;
}

/** Never throws; returns true on success. git first, Contents API fallback if git fails. */
export async function syncWallets({ git = realGit, fetch: f = globalThis.fetch, env = process.env, dir = repoDir(env), incoming } = {}) {
  if (!env.WALLETS_REPO_URL && !env.WALLETS_REPO_TOKEN && !env.WALLETS_REPO_DIR) return false;
  incoming ??= localWallets();
  try {
    return await syncViaGit(dir, incoming, { git, env });
  } catch (err) {
    console.warn(`[sync] WARN git sync failed: ${redact(err.message, env)}`);
    if (!repoToken(env)) { console.warn("[sync] WARN no token, API fallback skipped"); return false; }
    try { return await syncViaApi(incoming, { fetch: f, env }); }
    catch (e2) { console.warn(`[sync] WARN API fallback failed: ${redact(e2.message, env)}`); return false; }
  }
}

export function restoreWallets() {
  const dir = repoDir();
  if (ensureRepo(dir) === "empty") { console.log("[restore] backup repo is empty, nothing to restore"); return; }
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
