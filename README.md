# Lowcap Hunter

Harvests, audits, scores and re-audits Solana smart wallets from low-cap tokens (GMGN + Helius), then exports tiered (S/A/B/C) GMGN import lists to `output/`.

## Requirements
- Node.js 20+ (ESM), npm
- PM2 (optional): `npm i -g pm2`
- Helius API key and GMGN API key

## Install
```bash
git clone https://github.com/nodepedia/lowcap-hunter.git
cd lowcap-hunter
npm install
cp .env.example .env   # fill HELIUS_API_KEY, GMGN_API_KEY
```

## Run (CLI)
| Command | What it does |
|---|---|
| `npm run harvest` / `node src/index.js --harvest` | One harvest cycle (default mode) |
| `node src/index.js --harvest --fast` (or `--cached`) | Harvest using cached data, fewer API calls |
| `npm run reaudit` / `node src/index.js --reaudit` | Re-audit wallets in `data/wallets-db.json` |
| `node src/reaudit-wallets.js --force --cached` | Re-audit directly (force all / use cache) |
| `npm run daemon` / `node src/index.js --daemon` | Loop, one cycle every `HUNTER_CYCLE_MIN` min (default 45) |
| `npm run seed` | Seed tokens (`data/seeded-tokens.json`) |
| `npm run audit [maxStats]` | Audit wallets (default 12 stat calls) |
| `npm run filter` / `npm run score` | Filter / score wallets |
| `npm run export` | Export GMGN import lists to `output/` |

## Run with PM2
```bash
pm2 start src/index.js --name lowcap-hunter -- --daemon
# one-shot jobs:
pm2 start src/index.js --name lowcap-harvest --no-autorestart -- --harvest
pm2 start src/index.js --name lowcap-reaudit --no-autorestart -- --reaudit
pm2 logs lowcap-hunter
pm2 stop lowcap-hunter && pm2 delete lowcap-hunter
pm2 save   # persist after `pm2 startup`
```

## Output
- `data/wallets-db.json` — wallet database
- `output/gmgn_import_{S,A,B,C,all}.{json,txt}`, `latest_harvest_report.json`, `latest_reaudit_report.json`, `SUMMARY.md`

## Security
Never commit `.env` or API keys; `.gitignore` excludes them.

## Wallet backup (nodepedia/lowcap-wallets)
After each daemon cycle the hunter merges `output/wallets_report.json` into a private repo (one record per address, `firstSeenAt` kept, `lastSeenAt`/tier/stats updated), regenerates `gmgn_import_S.json`/`gmgn_import_A.json`, commits only if changed and pushes. Sync failures only log a warning.

Auth (pick one) in `.env`:
- **SSH deploy key:** `ssh-keygen -t ed25519 -f ~/.ssh/lowcap_wallets`, add the `.pub` as a deploy key with write access on the repo, add to `~/.ssh/config` (`Host github.com` / `IdentityFile ~/.ssh/lowcap_wallets`), then `WALLETS_REPO_URL=git@github.com:nodepedia/lowcap-wallets.git`.
- **HTTPS token:** fine-grained PAT with Contents read/write on the repo: `WALLETS_REPO_URL=https://github.com/nodepedia/lowcap-wallets.git` and `WALLETS_REPO_TOKEN=...`.

Optional `WALLETS_REPO_DIR` (default `~/lowcap-wallets`).

### New VPS setup
```
cd ~ && git clone git@github.com:nodepedia/lowcap-hunter.git && cd ~/lowcap-hunter
npm install && cp .env.example .env   # fill keys + WALLETS_REPO_*
npm run restore    # pulls ~/lowcap-wallets, copies files into output/ (and seeds data/ if empty)
pm2 start "npm run daemon" --name lowcap-hunter
```
Manual sync: `npm run sync`. Tests: `npm test`.
