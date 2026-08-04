# PropertySales AI — Vercel Deployment Guide

## Prerequisites

1. **Supabase project** (free tier) — sign up at [supabase.com](https://supabase.com)
2. **GitHub account** — [github.com](https://github.com)
3. **Vercel account** — sign up at [vercel.com](https://vercel.com) (use GitHub login)

---

## Step 1: Create a Supabase Project

1. Go to [supabase.com/dashboard](https://supabase.com/dashboard) → **New project**
2. Fill in:
   - **Name:** `propertysales-demo`
   - **Database password:** Create a strong one and save it
   - **Region:** Choose a region close to Pakistan (e.g. Singapore `ap-southeast-1` or Mumbai `ap-south-1`)
3. Click **Create new project** (takes ~2 minutes)
4. Once created, go to **Project Settings → API** and copy:
   - `Project URL` → this is your `NEXT_PUBLIC_SUPABASE_URL`
   - `anon public` key → this is your `NEXT_PUBLIC_SUPABASE_ANON_KEY`
   - `service_role` key → this is your `SUPABASE_SERVICE_ROLE_KEY` (keep secret!)

---

## Step 2: Run the Database Migrations

In the Supabase dashboard:

1. Go to **SQL Editor** → **New query**
2. Open each file from `supabase/migrations/` in order (001 to 036), copy the SQL, and paste it into the editor
3. Click **Run** for each one

**Faster method** — use the Supabase CLI (if you have it):
```bash
npx supabase link --project-ref your-project-ref
npx supabase db push
```

Or ask an AI to merge all 36 SQL files into one and run it.

---

## Step 3: Create a GitHub Repository

1. Go to [github.com/new](https://github.com/new)
2. **Repository name:** `propertysales-demo`
3. Keep it **Public** (free) or **Private** (if you prefer)
4. **Do NOT** initialize with README, .gitignore, or license
5. Click **Create repository**

Then run the commands GitHub shows you:

```bash
cd wacrm
git add .
git commit -m "Initial: wacrm fork for PropertySales AI"
git remote add origin https://github.com/YOUR_USERNAME/propertysales-demo.git
git branch -M main
git push -u origin main
```

Replace `YOUR_USERNAME` with your GitHub username.

---

## Step 4: Deploy to Vercel

1. Go to [vercel.com/dashboard](https://vercel.com/dashboard)
2. Click **Add New → Project**
3. Import your `propertysales-demo` GitHub repo
4. Vercel will auto-detect Next.js — the defaults are correct
5. In **Environment Variables**, add all of these:

| Name | Value |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | Your Supabase project URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Your Supabase anon key |
| `SUPABASE_SERVICE_ROLE_KEY` | Your Supabase service_role key |
| `ENCRYPTION_KEY` | Generate: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` |
| `META_APP_SECRET` | Generate any random string: `openssl rand -hex 16` (won't be used for demo) |
| `NEXT_PUBLIC_SITE_URL` | Will be set automatically after deploy (e.g. `https://propertysales-demo.vercel.app`) |
| `NEXT_PUBLIC_APP_LOCALE` | `en` |

6. Click **Deploy** (takes ~2-3 minutes)
7. Once done, Vercel gives you a URL like `https://propertysales-demo.vercel.app`

---

## Step 5: Sign Up at the App

1. Open your Vercel URL
2. Click **Sign Up**
3. Enter your email and password
4. You'll be logged in to the dashboard

---

## Step 6: Seed Demo Data

From your local machine:

```bash
cd wacrm

# Set your Supabase credentials
export SUPABASE_URL=https://your-project.supabase.co
export SUPABASE_SERVICE_ROLE_KEY=your-service-role-key

# Run the seed script with your login email
npx tsx scripts/seed.ts your@email.com
```

This creates:
- 10 demo contacts (Pakistani names + diaspora buyers)
- 5 demo conversations with full message histories
- 1 real estate pipeline with 7 stages
- 5 demo deals in various stages
- 3 message templates
- Tags (Hot Buyer, Diaspora, File Investor, etc.)

---

## Step 7: Explore the Demo

After seeding:

1. **Inbox** — see conversations with buyers looking for properties
2. **Contacts** — all 10 demo contacts with tags
3. **Pipelines** — real estate pipeline with deals from New Lead to Closed
4. **Dashboard** — charts and metrics

---

## Troubleshooting

| Problem | Likely Fix |
|---|---|
| `npm run build` fails | Check Node version in Vercel settings (use 20.x) |
| Login shows blank page | Check `NEXT_PUBLIC_SUPABASE_ANON_KEY` is correct |
| "Failed to find user" in seed | You signed up with a different email than you passed to seed.ts |
| 500 error on pages | Run the Supabase migrations — some might be missing |

---

## Next Steps After Demo

- Add your own properties to the database
- Configure the AI assistant (Settings → AI Assistant)
- Connect a real WhatsApp Business number
- Customize the pipeline stages for your agency
