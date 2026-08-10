# wacrm + Evolution API — Vercel Deployment Guide

Deploy the Next.js app (`wacrm/`) to Vercel, connected to your existing
Supabase project and self-hosted Evolution API instance on Railway.

> The Future of WhatsApp: this is the Fastest way to get it live on HTTPS.

---

## Before you start

You need:

1. **Supabase project** — already created (URL + anon key + service_role key).
2. **Existing `wacrm/.env.local`** — copy the values from here into Vercel so
   the deployed app uses the **same** `ENCRYPTION_KEY`, database, and Evolution
   credentials as your local setup. This file is git-ignored, it never leaves
   your machine.
3. **This repo on GitHub** — already pushed
   (`https://github.com/sulmanfarooqq/wacrm_evolution.git`, branch `main`).
4. **Vercel account** — sign up at [vercel.com](https://vercel.com) with the
   GitHub login.

`wacrm/` is the Next.js app. The repo also contains `docs/` and some local
files at the root — none of those deploy.

---

## Step 1: Deploy to Vercel

1. Go to [vercel.com/new](https://vercel.com/new) and **import** the
   `wacrm_evolution` repo.
2. `vercel.json` at the repo root already sets **Root Directory → `wacrm`**
   and framework → **Next.js**, so Vercel picks everything up automatically.
   You should see the Build/Run commands pre-filled with
   `npm run build` / `npm start`. If Root Directory asks, use `wacrm`.
3. **Environment Variables** — fastest way: import the ready-made file
   **`wacrm/.env.vercel`**. In Vercel → **Project → Settings → Environment
   Variables → Add**, paste the file's contents (multi-line `KEY=VALUE`) or
   upload it, then edit the one variable below. Or add them manually
   (values duplicate `wacrm/.env.local`):

| Name | Value |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | Your Supabase project URL (`https://xxxx.supabase.co`) |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Supabase **anon** key |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase **service_role** key (secret — server-only) |
| `ENCRYPTION_KEY` | **Copy the exact value from `wacrm/.env.local`.** Changing it orphans every stored token → WhatsApp config shows "can't be decrypted" until re-saved |
| `NEXT_PUBLIC_SITE_URL` | The app URL. `.env.vercel` has a placeholder here — replace it with your real URL (`https://wacrm-evolution.vercel.app`) before importing, or update it in Vercel after deploy + Redeploy |
| `NEXT_PUBLIC_APP_LOCALE` | `en` |
| `EVOLUTION_API_URL` | `https://evolution-api-production-3988.up.railway.app` (default for new/fresh accounts) |
| `EVOLUTION_API_KEY` | Your Evolution API key (default; per-account settings in the DB usually override) |

> `EVOLUTION_API_URL` / `EVOLUTION_API_KEY` are optional defaults — your
> existing account already has its own saved in Settings → WhatsApp and
> those win.

4. Click **Deploy** (~2–3 min). You'll get a URL like
   `https://wacrm-evolution.vercel.app`.
5. Update `NEXT_PUBLIC_SITE_URL` in **Vercel → Settings → Environment
   Variables** to the real URL and click **Redeploy**.

**Optional staging support:** add `SUPABASE_SERVICE_ROLE_KEY` etc. to the
Preview environment too if you want preview builds to hit the same DB.

---

## Step 2: First login

1. Open your Vercel URL → **Sign up** → email + password (Supabase Auth).
2. You land on `/dashboard`.

The database already exists (same Supabase project you use locally), so no
migrations to run. Demo/seed data is created by `wacrm/scripts/seed.ts` and
should be run **locally**, not on Vercel.

---

## Step 3: Reconnect WhatsApp (webhook points at Vercel)

The Evolution instance on Railway must POST events to your **deployed**
URL, not your old local tunnel.

1. In the app → **Settings → WhatsApp**.
2. The fields usually keep the saved instance `test1`, base URL, and API key.
   Click **Save** — the app re-runs the connection check and
   **auto-configures the webhook** to
   `https://<your-project>.vercel.app/api/whatsapp/webhook`
   (it uses `NEXT_PUBLIC_SITE_URL` or the request host).
3. Confirm "webhook configured" and instance state `open`.

**Verify end-to-end:** from another phone, message the connected number.
It should appear in the inbox and (if AI auto-reply is on with a Gemini key)
get an automatic reply within a few seconds.

> If the status shows "not connected", reopen the instance in the Evolution
> Manager and re-scan the QR. The API key you enter must match the `apikey`
> the instance sends on webhook events, or events get a 401.

---

## Step 4: Keep automations running (Hobby plan — free cron)

Wait steps in automations (drain `/api/automations/cron`) need a scheduled
caller. Vercel Cron is paid; this repo ships a free **GitHub Actions**
workflow instead:

1. `AUTOMATION_CRON_SECRET` is already inside `wacrm/.env.vercel`. It's a
   shared secret, so generate your own fresh one instead
   (`openssl rand -hex 32`) and use that value everywhere:
2. In Vercel, make sure env var **`AUTOMATION_CRON_SECRET`** holds that value
   and **Redeploy**.
3. In GitHub (`wacrm_evolution` → **Settings → Secrets and variables →
   Actions → New repository secret**) add:
   - `CRON_URL` → `https://<your-project>.vercel.app`
   - `AUTOMATION_CRON_SECRET` → same value as above
4. Open the **Actions** tab → the "drain automation wait-steps" workflow →
   **Enable workflow**. It now runs every 5 minutes.

No secrets configured? The app still deploys and works — only Wait steps
won't advance until you set this up. (Alternative external pinger:
cron-job.org / UptimeRobot hitting the cron URL with the `x-cron-secret`
header.)

---

## Troubleshooting

| Problem | Likely fix |
|---|---|
| Import shows "no package.json" | `vercel.json` Root Directory is `wacrm` — confirm it's set on the project (Settings → General) if the import didn't apply it |
| Build fails / env crashed at build | Make sure `NEXT_PUBLIC_SUPABASE_URL` + `NEXT_PUBLIC_SUPABASE_ANON_KEY` are set for the production environment before building |
| Blank login page | `NEXT_PUBLIC_SUPABASE_ANON_KEY` mismatch — Vercel env must match `wacrm/.env.local` |
| "Stored API key can't be decrypted" | `ENCRYPTION_KEY` differs from the one used when the config was saved — click **Reset Configuration**, re-save |
| No inbound messages | Webhook points at the old tunnel — re-save WhatsApp config (step 3); confirm `NEXT_PUBLIC_SITE_URL` |
| Webhook 401 | Saved API key ≠ instance's `apikey` — update and re-save config |
| Automations Wait step stuck | Enable the GitHub Actions cron (step 4) or an external pinger |
| Long webhook/broadcast timeouts | Routes use `maxDuration = 60` (Hobby max). Large broadcasts should be split into smaller batches |

---

## Health check after deploy

- [ ] Home/login page loads on `https://<your-project>.vercel.app`
- [ ] Sign-up works (new account → dashboard)
- [ ] Settings → WhatsApp shows connected + webhook configured
- [ ] Send/receive a WhatsApp message end-to-end
- [ ] GitHub Actions "drain automation wait-steps" enabled (or pinger set)