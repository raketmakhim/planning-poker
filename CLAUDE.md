# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Planning Poker: a single global voting session (no rooms, no accounts). Everyone who opens the site joins the same board, picks a display name, and votes on a Fibonacci scale.

## Commands

**Frontend** (`frontend/`):
- `npm run dev` — Vite dev server (hot reload), reads `VITE_API_URL` from `frontend/.env`
- `npm run build` — production build to `frontend/dist/`
- `npm run lint` — oxlint

**Infra** (`infra/`):
- `terraform init -backend-config=backend.hcl -upgrade` — after changing provider version constraints (backend bucket/region are passed via `backend.hcl`, gitignored, not hardcoded — see `backend.hcl.example`)
- `terraform plan` / `terraform apply` — infra changes only (DynamoDB, IAM, Lambda, S3, CloudFront); state is remote (S3 backend, native S3 locking, no DynamoDB lock table)
- Backend Lambda source is zipped straight from `backend/` by the `archive_file` data source in `lambda.tf` — no build step, just edit `backend/index.py` and re-apply

**Deploy everything**: `npm run deploy` (runs `deploy.mjs`) from the repo root — one script does infra apply *and* frontend build/deploy, but Terraform still never touches the build output directly. `deploy.mjs` runs `terraform plan -detailed-exitcode` and only applies if there's an actual diff, then separately hashes the frontend source (`src/`, `public/`, config files, `.env`) and only rebuilds/syncs/invalidates if that hash changed since the last deploy (cached in the gitignored `.frontend-deploy-hash`). It also auto-generates `frontend/.env` from the live `function_url` Terraform output, and auto-creates `infra/backend.hcl`/`infra/terraform.tfvars` from their `.example` files on first run (stopping until `<REPLACE_ME>` placeholders are filled in).

**Backend has no test harness** — verify changes by `terraform apply` then `curl` against the deployed Function URL (`terraform output -raw function_url` from `infra/`).

## Architecture

No servers, no WebSockets. Frontend polls a REST-ish API every 1.5s (`POLL_MS` in `frontend/src/App.jsx`); polling doubles as heartbeat/presence.

```
Browser --HTTP poll/POST--> Lambda Function URL --> DynamoDB (single item, PK "SESSION")
Browser <--HTTPS------------ CloudFront <-- S3 (static frontend build)
```

- **`backend/index.py`**: one Lambda function, hand-routed by `(method, path)` — no framework/router. Reads/writes a single DynamoDB item holding `story`, `revealed`, and a `participants` map keyed by `clientId`. Votes are hidden from the API response until `revealed` is true (`to_public()` strips them).
- **`clientId`**: a random UUID the frontend generates once and keeps in `sessionStorage` — this is the only notion of "identity" in the system. It is not auth; it just tells the backend which participant a request belongs to. Two browser tabs are two participants even with the same display name.
- **Presence**: no `$disconnect`-style signal (there's no persistent connection). A participant is dropped from `participants` if `lastSeen` is older than `STALE_MS` (10s) — pruned server-side on every request via `prune_stale()`. Closing a tab means the participant lingers for up to ~10s.
- **No host role**: every action (`setStory`, `vote`, `reveal`, `newRound`) is callable by any participant. There is no server-side authorization check to add here by design.
- **Terraform state bootstrap**: the S3 backend bucket itself was created manually (one-time, not in Terraform — chicken-and-egg). If it's ever lost, recreate it by hand with versioning + encryption before `terraform init` will work.
