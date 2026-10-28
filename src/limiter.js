import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { OpenApiClient } from "gmgn-cli/dist/client/OpenApiClient.js";
import { getConfig } from "gmgn-cli/dist/config.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT_DIR = path.resolve(__dirname, "..");
export const DATA_DIR = path.join(ROOT_DIR, "data");
export const OUTPUT_DIR = path.join(ROOT_DIR, "output");

dotenv.config({ path: path.join(ROOT_DIR, ".env") });

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(OUTPUT_DIR, { recursive: true });

const RATE_STATE_FILE = path.join(DATA_DIR, "rate-state.json");
const WALLETS_DB_FILE = path.join(DATA_DIR, "wallets-db.json");
const SEEDED_TOKENS_FILE = path.join(DATA_DIR, "seeded-tokens.json");

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function readJsonSafe(filePath, fallback) {
  try {
    if (fs.existsSync(filePath)) {
      return JSON.parse(fs.readFileSync(filePath, "utf8"));
    }
  } catch (err) {
    console.error(`[warn] Failed reading ${filePath}: ${err.message}`);
  }
  return fallback;
}

export function writeJsonAtomic(filePath, data) {
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), "utf8");
  fs.renameSync(tmp, filePath);
}

export function loadWalletsDb() {
  return readJsonSafe(WALLETS_DB_FILE, {
    updatedAt: null,
    wallets: {},
  });
}

export function saveWalletsDb(db) {
  db.updatedAt = new Date().toISOString();
  writeJsonAtomic(WALLETS_DB_FILE, db);
}

export function loadSeededTokens() {
  return readJsonSafe(SEEDED_TOKENS_FILE, {
    updatedAt: null,
    tokens: [],
  });
}

export function saveSeededTokens(data) {
  data.updatedAt = new Date().toISOString();
  writeJsonAtomic(SEEDED_TOKENS_FILE, data);
}

export class GmgnRateLimiter {
  constructor() {
    this.minGapMs = Math.ceil(Number(process.env.GMGN_MIN_GAP_SEC || 15.5) * 1000);
    this.maxPerMin = Number(process.env.GMGN_MAX_PER_MIN || 4);
    this.client = new OpenApiClient(getConfig());
  }

  _loadState() {
    return readJsonSafe(RATE_STATE_FILE, {
      lastCallMs: 0,
      recentCallsMs: [],
      bannedUntilMs: 0,
    });
  }

  _saveState(state) {
    writeJsonAtomic(RATE_STATE_FILE, state);
  }

  async waitForSlot(label = "gmgn-call") {
    while (true) {
      const now = Date.now();
      const state = this._loadState();
      state.recentCallsMs = (state.recentCallsMs || []).filter((t) => now - t < 62000);

      if (state.bannedUntilMs && now < state.bannedUntilMs) {
        const waitMs = state.bannedUntilMs - now + 1500;
        console.log(`[limiter] Respecting cooldown until reset (${Math.ceil(waitMs / 1000)}s) before ${label}...`);
        await sleep(waitMs);
        continue;
      }

      const sinceLast = now - (state.lastCallMs || 0);
      if (sinceLast < this.minGapMs) {
        const waitMs = this.minGapMs - sinceLast;
        console.log(`[limiter] Waiting ${(waitMs / 1000).toFixed(1)}s for min-gap before ${label}...`);
        await sleep(waitMs);
        continue;
      }

      if (state.recentCallsMs.length >= this.maxPerMin) {
        const oldest = state.recentCallsMs[0];
        const waitMs = 62500 - (now - oldest);
        if (waitMs > 0) {
          console.log(`[limiter] Rolling window full (${state.recentCallsMs.length}/${this.maxPerMin}); waiting ${(waitMs / 1000).toFixed(1)}s before ${label}...`);
          await sleep(waitMs);
          continue;
        }
      }

      const callTime = Date.now();
      state.lastCallMs = callTime;
      state.recentCallsMs.push(callTime);
      this._saveState(state);
      return;
    }
  }

  async call(label, fn, maxRetries = 2) {
    for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
      await this.waitForSlot(label);
      try {
        console.log(`[gmgn] -> ${label}`);
        const res = await fn(this.client);
        return res;
      } catch (err) {
        const msg = err?.message || String(err);
        console.error(`[gmgn] Error on ${label} (attempt ${attempt}): ${msg}`);

        const state = this._loadState();
        if (err?.resetAtUnix) {
          state.bannedUntilMs = err.resetAtUnix * 1000 + 3000;
          this._saveState(state);
        } else if (msg.includes("429") || msg.includes("RATE_LIMIT")) {
          state.bannedUntilMs = Date.now() + 65000;
          this._saveState(state);
        } else {
          // Business or validation error — do NOT blindly retry to avoid ERROR_RATE_LIMIT_BLOCKED
          throw err;
        }

        if (attempt > maxRetries) {
          throw err;
        }
      }
    }
  }
}

export const gmgnLimiter = new GmgnRateLimiter();
