import test from "node:test";
import assert from "node:assert/strict";
import { mergeWallets, gmgnImport } from "../src/sync-wallets.js";

test("dedupes duplicates in input and updates on re-find", () => {
  const a = "6bnQ7Ea1eSHVNKpkzPFUVZtL14ZDQ3cerfTYLpRJowWf", b = "BKRguFtHn5pSA8TbSHq8zVxnmyHTxrfF3EfBGfQycLcW";
  const first = mergeWallets([], [{ address: b, tier: "A" }, { address: ` ${b} `, tier: "A", score: 1 }, { address: a, tier: "S" }], "t1");
  assert.equal(first.length, 2);
  assert.deepEqual(first.map((w) => w.address), [a, b]);
  const second = mergeWallets(first, [{ address: b, tier: "S", score: 9 }, { address: b, tier: "S", score: 10 }], "t2");
  assert.equal(second.length, 2);
  const wb = second.find((w) => w.address === b);
  assert.equal(wb.tier, "S"); assert.equal(wb.score, 10);
  assert.equal(wb.firstSeenAt, "t1"); assert.equal(wb.lastSeenAt, "t2");
  assert.equal(gmgnImport(second, "S").length, 2);
});

// ---- sync transport / error handling (mocked, no network, fake token) ----
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { repoUrl, repoToken, redact, classifyGitError, GitError, ensureRepo, syncWallets, syncViaApi } from "../src/sync-wallets.js";

const FAKE = "ghp_FAKEfake0000000000000000000000000000";
const ENV = { WALLETS_REPO_URL: "https://github.com/nodepedia/lowcap-wallets.git", WALLETS_REPO_TOKEN: FAKE };
const quiet = () => { const o = [console.log, console.warn], logs = []; console.log = console.warn = (...a) => logs.push(a.join(" ")); return { logs, restore: () => ([console.log, console.warn] = o) }; };

test("repoUrl sanitizes token whitespace/CRLF/quotes and pre-existing user@", () => {
  assert.equal(repoUrl({ ...ENV, WALLETS_REPO_TOKEN: ` "${FAKE}"\r\n` }), `https://x-access-token:${FAKE}@github.com/nodepedia/lowcap-wallets.git`);
  assert.equal(repoUrl({ ...ENV, WALLETS_REPO_URL: "https://nodepedia@github.com/nodepedia/lowcap-wallets.git" }), `https://x-access-token:${FAKE}@github.com/nodepedia/lowcap-wallets.git`);
  assert.equal(repoUrl({ WALLETS_REPO_URL: ENV.WALLETS_REPO_URL, WALLETS_REPO_TOKEN: "" }), ENV.WALLETS_REPO_URL); // no creds -> must not be cloned over https
  assert.equal(repoToken({ WALLETS_REPO_TOKEN: "a b" }), "a b");
});

test("redact removes token from any text", () => {
  const s = redact(`fatal: https://x-access-token:${FAKE}@github.com/x ${FAKE} ghp_other123`, ENV);
  assert.ok(!s.includes(FAKE) && !s.includes("ghp_other123"));
});

test("classify invalid token vs repo not found vs empty", () => {
  assert.equal(classifyGitError("remote: Invalid username or token. Password authentication is not supported for Git operations.\nfatal: Authentication failed"), "invalid_token");
  assert.equal(classifyGitError("remote: Repository not found.\nfatal: repository 'https://github.com/x/y.git/' not found"), "repo_not_found");
  assert.equal(classifyGitError("warning: You appear to have cloned an empty repository."), "empty_repo");
  const e = new GitError(["clone", `https://x-access-token:${FAKE}@github.com/a/b.git`], `fatal: Authentication failed for 'https://x-access-token:${FAKE}@github.com/a/b.git'`, 128, ENV);
  assert.equal(e.kind, "invalid_token"); assert.ok(!e.message.includes(FAKE)); assert.match(e.message, /exit 128/);
});

test("ensureRepo: empty token over https fails fast as invalid_token (no clone)", () => {
  const calls = [];
  assert.throws(() => ensureRepo(path.join(os.tmpdir(), "nope-" + Date.now()), { git: (a) => calls.push(a), env: { WALLETS_REPO_URL: ENV.WALLETS_REPO_URL, WALLETS_REPO_TOKEN: " " } }), (e) => e.kind === "invalid_token");
  assert.equal(calls.length, 0);
});

test("empty repo clone = success, first push uses -u origin main", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lw-")) + "/repo", calls = [];
  const git = (a, cwd) => {
    calls.push(a.join(" "));
    if (a[0] === "clone") { fs.mkdirSync(path.join(a[2], ".git"), { recursive: true }); return ""; }
    if (a[0] === "rev-parse") throw new GitError(a, "fatal: Needed a single revision", 1, ENV);
    if (a[0] === "status") return "A wallets.json";
    return "";
  };
  const q = quiet();
  try { assert.equal(await syncWallets({ git, env: ENV, dir, incoming: [{ address: "W1", tier: "S" }], fetch: () => { throw new Error("no network"); } }), true); }
  finally { q.restore(); }
  assert.ok(calls.includes("checkout -q -B main"));
  assert.ok(calls.includes("push --quiet -u origin main"));
  assert.ok(!q.logs.join("\n").includes(FAKE));
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "gmgn_import_S.json"))).length, 1);
});

function mockGithub(initial = {}) {
  const store = { ...initial }, reqs = [];
  const fetch = async (url, opts = {}) => {
    const name = url.split("/contents/")[1]; reqs.push({ method: opts.method || "GET", name, opts });
    assert.equal(opts.headers.Authorization, `Bearer ${FAKE}`);
    const res = (status, body) => ({ status, ok: status < 300, json: async () => body, text: async () => JSON.stringify(body) });
    if (!opts.method) return store[name] ? res(200, { sha: store[name].sha, content: Buffer.from(store[name].text).toString("base64") }) : res(404, { message: "Not Found" });
    const b = JSON.parse(opts.body);
    if (store[name] && b.sha !== store[name].sha) return res(409, { message: "sha mismatch" });
    store[name] = { sha: "sha-" + reqs.length, text: Buffer.from(b.content, "base64").toString() };
    return res(store[name] ? 200 : 201, {});
  };
  return { store, reqs, fetch };
}

test("API fallback runs only when git fails: create then update with sha, dedup", async () => {
  const gh = mockGithub();
  const failGit = (a) => { throw new GitError(a, "remote: Invalid username or token. Password authentication is not supported for Git operations.", 128, ENV); };
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "lw-")), "repo");
  const q = quiet();
  try {
    assert.equal(await syncWallets({ git: failGit, fetch: gh.fetch, env: ENV, dir, incoming: [{ address: "W1", tier: "S" }, { address: "W1", tier: "S" }] }), true);
    const puts1 = gh.reqs.filter((r) => r.method === "PUT");
    assert.equal(puts1.length, 3);
    assert.ok(puts1.every((r) => JSON.parse(r.opts.body).message === "sync: 1 wallets" && !("sha" in JSON.parse(r.opts.body))));
    gh.reqs.length = 0;
    assert.equal(await syncViaApi([{ address: "W2", tier: "A" }], { fetch: gh.fetch, env: ENV, now: "t2" }), true);
    const puts2 = gh.reqs.filter((r) => r.method === "PUT");
    assert.ok(puts2.length >= 2 && puts2.every((r) => JSON.parse(r.opts.body).sha?.startsWith("sha-")));
    assert.equal(JSON.parse(gh.store["wallets.json"].text).count, 2);
  } finally { q.restore(); }
  const out = q.logs.join("\n");
  assert.match(out, /invalid_token/); assert.match(out, /api/); assert.ok(!out.includes(FAKE));
});

test("git success => API not called", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lw-")); fs.mkdirSync(path.join(dir, ".git"));
  let fetched = false; const q = quiet();
  try { assert.equal(await syncWallets({ git: (a) => (a[0] === "status" ? "" : ""), fetch: () => { fetched = true; }, env: ENV, dir, incoming: [] }), true); }
  finally { q.restore(); }
  assert.equal(fetched, false);
});
