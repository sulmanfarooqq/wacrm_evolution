# wacrm + Evolution API — Vercel Deployment Guide

Deploy the Next.js app (`wacrm/`) to Vercel, connected to your existing
Supabase project and self-hosted Evolution API instance on Railway.

> **Live deployment:** https://wacrm-evolution.vercel.app
> (project: `wacrm_evolution`, Vercel team `sulmanfarooqs-projects`)

---

## Before you start

You need:

1. **Supabase project** — URL + anon key + service_role key.
2. **Existing `wacrm/.env.local`** — the deployed app must use the **same**
   `ENCRYPTION_KEY`, database, and Evolution credentials as your local setup.
   This file is git-ignored, it never leaves your machine.
3. **This repo on GitHub** — `https://github.com/sulmanfarooqq/wacrm_evolution.git`,
   branch `main`.
4. **Vercel account** — sign up at [vercel.com](https://vercel.com) with the
   GitHub login.

`wacrm/` is the Next.js app (Next.js 16, App Router, Node.js runtime). The repo
root also contains `docs/`, `vercel.json`, and local-only files
(`evolutionapi`, `cf-*.log` — git-ignored). Only `wacrm/` deploys.

---

## Step 1: Deploy to Vercel

1. Go to [vercel.com/new](https://vercel.com/new) and **import** the
   `wacrm_evolution` repo.
2. **Set Root Directory → `wacrm`.** This is a **project setting**, not a
   `vercel.json` key (Vercel removed `rootDirectory` from the `vercel.json`
   schema — putting it there fails with
   *"should NOT have additional property `rootDirectory`"*).
   - Vercel's framework detection usually spots the Next.js app in `wacrm/`
     and pre-fills Root Directory on the import screen.
   - If it doesn't, pick `wacrm` from the dropdown, or set it later under
     **Settings → General → Build & Development Settings → Root Directory →
     Edit → `wacrm`**.
   - ⚠️ Vercel applies settings changes only from your **next** deployment.
     After saving the setting, create a **new** deployment (Deployments tab →
     **Deploy**, or push a commit) — do not "Redeploy" an old one, it reuses
     the old setting.
   - `vercel.json` at the repo root pins `framework: nextjs` + `npm run build`,
     so the Build command comes pre-filled.
3. **Environment Variables** — fastest way: import the ready-made file
   **`wacrm/.env.vercel`** (all values pre-filled, git-ignored). In Vercel →
   **Project → Settings → Environment Variables → Add**, paste the file's
   contents (multi-line `KEY=VALUE`) or upload it. Or add them manually:

| Name | Value |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase project URL (`https://crqrfosgydbwxkmtryhy.supabase.co`) |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Supabase **anon** key |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase **service_role** key (secret — server-only) |
| `ENCRYPTION_KEY` | **Exact value from `wacrm/.env.local`.** Changing it orphans every stored token → WhatsApp shows "can't be decrypted" until re-saved |
| `NEXT_PUBLIC_SITE_URL` | `https://wacrm-evolution.vercel.app` (build-time — set before deploy, or set + Redeploy after) |
| `NEXT_PUBLIC_APP_LOCALE` | `en` |
| `EVOLUTION_API_URL` | `https://evolution-api-production-3988.up.railway.app` (default for new accounts) |
| `EVOLUTION_API_KEY` | Evolution API key (default; per-account settings in the DB override) |
| `AUTOMATION_CRON_SECRET` | Long random string guarding `/api/automations/cron` (see Step 4) |

> `EVOLUTION_API_URL` / `EVOLUTION_API_KEY` are optional defaults — the
> existing account already has its own saved in Settings → WhatsApp and those
> win.

4. Click **Deploy** (~2–3 min). Success = a green build and a URL like
   `https://wacrm-evolution.vercel.app`.

**First-build gotcha you will hit if Root Directory is wrong:** the build log
ends with *"No Next.js version detected … check your Root Directory setting"*.
That means the project is building from the repo root (no `package.json`
there). Fix = set Root Directory to `wacrm` (step 2) and create a new
deployment.

**Use the production URL, not the preview URL.** After a git push you'll see
deployment URLs like `wacrm-evolution-gs6ixoz9e-sulmanfarooqs-projects.vercel.app`.
Those are **preview** deployments and are protected by the team's SSO — opening
one 302s to `vercel.com/sso-api`. Use `https://wacrm-evolution.vercel.app` for
everything (webhook config, cron URL, `NEXT_PUBLIC_SITE_URL`).

---

## Step 2: First login

1. Open `https://wacrm-evolution.vercel.app` → **Sign up** → email + password
   (Supabase Auth).
2. You land on `/dashboard`.

The database already exists (same Supabase project used locally), so no
migrations to run on Vercel. Demo/seed data comes from `wacrm/scripts/seed.ts`
and is run **locally**.

---

## Step 3: Reconnect WhatsApp (webhook points at Vercel)

The Evolution instance on Railway must POST events to the **deployed** URL, not
your old local tunnel.

1. In the app → **Settings → WhatsApp**.
2. Fields usually keep the saved instance `test1`, base URL, and API key. Click
   **Save** — the app re-runs the connection check and **auto-configures the
   webhook** to `https://wacrm-evolution.vercel.app/api/whatsapp/webhook`
   (it derives the URL from `NEXT_PUBLIC_SITE_URL` or the request host).
3. Confirm "webhook configured" and instance state `open`.

**Verify end-to-end:** from another phone, message the connected number. It
should appear in the inbox and (if AI auto-reply is on with a Gemini key) get
an automatic reply within a few seconds.

> If status shows "not connected", reopen the instance in the Evolution Manager
> and re-scan the QR. The API key must match the `apikey` the instance sends on
> webhook events, or events get a 401.

---

## Step 4: Keep automations running (Hobby plan — free cron)

Wait steps in automations drain via `/api/automations/cron`, which needs a
scheduled caller. Vercel Cron is paid; this repo ships a free **GitHub
Actions** workflow (`.github/workflows/cron-automations.yml`) that pings it
every 5 minutes.

> **Why this exists:** a "Wait 10 minutes" step stores a pending row
> (`automation_pending_executions`) with a `run_at` timestamp. Nothing inside
> the app wakes it up — the cron endpoint finds due rows and resumes them. If
> you don't use Wait steps, you can skip this entirely.

**Setup (one time):**

1. **The secret** — `AUTOMATION_CRON_SECRET` is pre-filled in
   `wacrm/.env.vercel` (`89c1d0a3…c4d5a6b`). Better: generate your own with
   `openssl rand -hex 32` and use that value everywhere. Keep a copy in a
   password manager — it guards the cron endpoint.
2. **Vercel** — confirm `AUTOMATION_CRON_SECRET` is set under **Settings →
   Environment Variables** (it is, if you imported `.env.vercel`), then
   **Redeploy** so the running app picks it up.
3. **GitHub secrets** — repo → **Settings → Secrets and variables → Actions →
   New repository secret**, add twice:
   - `CRON_URL` → `https://wacrm-evolution.vercel.app`
   - `AUTOMATION_CRON_SECRET` → the same value as Vercel
4. **Enable the workflow** — repo → **Actions** tab → "drain automation
   wait-steps" → **Enable workflow**. To test immediately: **Run workflow**.

**Verify:** after a run, the "Drain due automation executions" step is green.
If it fails, re-check both secret names/values match Vercel's exactly.

No secrets configured? The app still deploys and works — only Wait steps won't
advance until you set this up. (Alternative external pinger: cron-job.org /
UptimeRobot hitting `…/api/automations/cron` with the `x-cron-secret` header.)

---

## Troubleshooting

| Problem | Likely fix |
|---|---|
| Build log: "Invalid request: should NOT have additional property `rootDirectory`" | `rootDirectory` is not a `vercel.json` key anymore — remove it from `vercel.json`; set Root Directory in the project settings instead |
| Build log: "No Next.js version detected … check your Root Directory" | Root Directory is still the repo root. Set it to `wacrm` (Settings → General), then create a **new** deployment — settings apply from the next deployment |
| Build fails / env crashed at build | `NEXT_PUBLIC_SUPABASE_URL` + `NEXT_PUBLIC_SUPABASE_ANON_KEY` must be set for the production environment before building |
| A `…-sulmanfarooqs-projects.vercel.app` URL shows the Vercel login page | That's a **preview** deployment URL behind team SSO. Use the production URL `https://wacrm-evolution.vercel.app` |
| Blank login page | `NEXT_PUBLIC_SUPABASE_ANON_KEY` mismatch — Vercel env must match `wacrm/.env.local` |
| "Stored API key can't be decrypted" | `ENCRYPTION_KEY` differs from the one used when the config was saved — click **Reset Configuration**, re-save |
| No inbound messages | Webhook points at the old tunnel — re-save WhatsApp config (Step 3); confirm `NEXT_PUBLIC_SITE_URL` |
| Webhook 401 | Saved API key ≠ instance's `apikey` — update and re-save config |
| Automations Wait step stuck | Enable the GitHub Actions cron (Step 4) or an external pinger |
| Long webhook/broadcast timeouts | Routes use `maxDuration = 60` (Hobby max). Split large broadcasts into smaller batches |

---

## Health check after deploy

- [ ] `https://wacrm-evolution.vercel.app` loads (login page)
- [ ] Sign-up works (new account → dashboard)
- [ ] Settings → WhatsApp shows connected + webhook configured
- [ ] Send/receive a WhatsApp message end-to-end
- [ ] GitHub Actions "drain automation wait-steps" enabled (or pinger set)

---

## Repo files that make this work

| File | Role |
|---|---|
| `vercel.json` (repo root) | Framework + build command for the import (no `rootDirectory` — that's a project setting) |
| `wacrm/.env.vercel` | One-file, ready-to-import env vars for Vercel (git-ignored, secrets stay local) |
| `.github/workflows/cron-automations.yml` | Free Hobby-plan pinger for `/api/automations/cron` |
| `wacrm/src/proxy.ts` | Next 16 auth proxy (runs on the Node runtime — Supabase `getUser()` works on Vercel) |
| `wacrm/src/app/api/whatsapp/webhook/route.ts` | Inbound Evolution webhook (uses `after()` + `maxDuration = 60`) |