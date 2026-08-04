# wacrm + Evolution API — Setup & Go-Live Runbook

Everything you need to turn `wacrm` into a working **WhatsApp AI auto-reply
system** backed by your self-hosted Evolution API instance (instance `test1` on
Railway, already connected to `sulmanfarooqq923425034517@s.whatsapp.net`).

---

## 0. What you already have

| Thing | Value |
|---|---|
| Evolution API version | v2.3.7 |
| Instance name | `test1` (note: `evolution_exchange` is the WhatsApp profile name shown in the Manager, **not** the instance name) |
| Instance API key | `AC1B5DE9D585-4678-BFFD-8AC38C2A8F03` |
| Instance base URL | `https://evolution-api-production-3988.up.railway.app` |
| WhatsApp number | `sulmanfarooqq923425034517@s.whatsapp.net` (state `open`) |
| Webhook | configured on `test1` with events `MESSAGES_UPSERT`, `MESSAGES_UPDATE`, `CONNECTION_UPDATE` |
| wacrm codebase | `C:\Users\my\Desktop\evolution\wacrm` (migration complete, all tests green) |

**What you still need to get:** a **Google Gemini API key** (from
aistudio.google.com). The Evolution API key is already known and saved — see the
table above. (Note: the key in the table is the instance token from the Manager;
it must be used both as the wacrm saved key and as the webhook's `apikey`.)

---

## 1. Create the database (Supabase)

1. Create a free project at [supabase.com](https://supabase.com).
2. In **Project Settings → API**, copy three values:
   - `Project URL` (e.g. `https://xxxx.supabase.co`)
   - `anon public key`
   - `service_role key` (secret — server-side only)
3. Apply the migrations — every file in `wacrm/supabase/migrations/` (at least
   `001` → `037`). Two options:
   - CLI: `supabase db push` from `wacrm/` (requires a linked project), or
   - Paste each `*.sql` file into **Supabase → SQL Editor → New query** in order,
     running them sequentially (037 is the Evolution migration).

> `037_evolution_provider.sql` is idempotent and can be re-run safely.

---

## 2. Environment variables

Copy `wacrm/.env.local.example` to `wacrm/.env.local` and fill in:

```env
# --- Required ---
NEXT_PUBLIC_SUPABASE_URL=your-project-url
NEXT_PUBLIC_SUPABASE_ANON_KEY=your-anon-key
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key

# AES-256-GCM key for encrypted tokens (64 hex chars = 32 bytes)
# generate with:
#   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
ENCRYPTION_KEY=your-64-char-hex-key-here

# Your app's public URL (used for the webhook + sitemap)
NEXT_PUBLIC_SITE_URL=https://your-public-url

# --- Optional (per-account values in Settings override these) ---
EVOLUTION_API_URL=https://evolution-api-production-3988.up.railway.app
EVOLUTION_API_KEY=your-evolution-api-key
```

- `ENCRYPTION_KEY` must be the **same in every environment** that shares a
  database — changing it orphans stored keys and forces users to re-save config.
- No `META_APP_SECRET` / `META_APP_ID` needed anymore.
- The Gemini key is **not** an env var — it's entered per-account in
  **Settings → AI Assistant** and stored encrypted.

---

## 3. Make the webhook reachable (public HTTPS)

Evolution POSTs events to your app at `/api/whatsapp/webhook`, so the app must
be running at a public HTTPS URL that your Railway Evolution instance can reach.

- **Local testing:** run `npm run dev` and put a tunnel in front of it, e.g.
  `cloudflared tunnel --url http://localhost:3000` (free) or ngrok.
  - Current local tunnel: `https://deposit-pleasant-buck-apartment.trycloudflare.com`
    (cloudflared). **The URL rotates every time the tunnel restarts** — after a
    restart, update `NEXT_PUBLIC_SITE_URL` and re-save the WhatsApp config so
    the webhook points at the new URL (or use a stable domain for production).
- **Production:** deploy to Vercel / Railway / Hostinger and set
  `NEXT_PUBLIC_SITE_URL` to the deployed URL.
- The webhook is **POST-only** and token-authenticated by the event body's
  `apikey` — no verification-token challenge, no HMAC secret to share.

---

## 4. Run / deploy the app

```bash
cd wacrm
npm install
npm run dev        # local dev
# or
npm run build && npm start   # production
```

Then sign up / log in to the app (Supabase Auth handles accounts).

---

## 5. Connect WhatsApp (Settings → WhatsApp)

Fill in the three fields:

| Field | Value |
|---|---|
| Instance Name | `test1` |
| API Base URL | `https://evolution-api-production-3988.up.railway.app` |
| API Key | `AC1B5DE9D585-4678-BFFD-8AC38C2A8F03` |

Click **Save**. On save, the app:

1. Verifies the instance + key (`GET /instance/connectionState/{instance}` —
   must be state `open`).
2. Auto-configures the webhook to `{your-app-url}/api/whatsapp/webhook` with
   events `MESSAGES_UPSERT`, `MESSAGES_UPDATE`, `CONNECTION_UPDATE`.
3. Stores the key AES-256-GCM-encrypted and records `webhook_configured_at`.

You should see "webhook configured" in the UI. If the instance shows a
"not connected" state, reopen the instance in the Evolution Manager and
re-scan the QR.

> The API key you save must be the **same token the instance's webhook sends as
> `apikey`** in each event — wacrm matches them to authenticate inbound traffic.
> A mismatch shows up as a 401 on the webhook.

---

## 6. Turn on the AI auto-reply (Settings → AI Assistant)

1. **Provider:** `Gemini` (already the default).
2. **API key:** paste a Google Gemini API key (create one at
   https://aistudio.google.com → Get API key). Stored encrypted; never leaves
   your server.
3. **Model:** `gemini-2.5-flash` (default).
4. **System prompt:** describe your business, tone, and reply rules, e.g.
   *"You are the support bot for {business}. Answer briefly and helpfully in
   the customer's language."*
5. Toggle **Auto-reply ON** and set the max replies per conversation.
6. Optional: add a **knowledge base** (Q&A documents) so answers are grounded
   in your business data.

### When the AI replies

Every inbound WhatsApp message that no flow/automation consumed triggers a
Gemini reply automatically, **as long as**:
- Auto-reply is enabled for the account,
- **no human agent is assigned** to the conversation,
- auto-reply was not disabled for that conversation,
- the per-conversation reply cap hasn't been hit.

A human taking the conversation (assigning themselves) hands off from the AI.
Assigning works from the conversation's agent controls in the inbox.

---

## 7. Go live — end-to-end test

1. Start the app + tunnel (or use the deployed URL).
2. Save the WhatsApp config (step 5) and confirm the webhook is configured.
3. Enable AI auto-reply with a Gemini key (step 6).
4. From a **different** phone, send a WhatsApp message to
   `+9…` (the number connected to instance `test1`).
5. Expected:
   - The message appears in the app's inbox.
   - Gemini replies automatically within a few seconds.
   - Statuses update to delivered/read as they arrive.

---

## 8. Optional: deterministastic flows & automations

The AI is the fallback responder. For deterministic behaviour you can build:

- **Flows** (chatbot menus) — scripted button/list menus driven by the flows
  engine. Interactive replies from Evolution are normalized back into the flow
  inputs automatically.
- **Automations** — e.g. `new_message_received` / `keyword_match` auto-texts,
  `first_inbound_message` responses, tag-triggered actions.
- **Broadcasts** — send the same message to many contacts (sends free-form
  text; Evolution has no Meta-template broadcast).

> If an account has an active `new_message_received` or `keyword_match`
> automation, AI auto-reply **stands down** for it (deterministic wins, to
> avoid double-texting customers).

---

## 9. Troubleshooting

| Symptom | Likely cause / fix |
|---|---|
| Save says "not connected" | Instance state isn't `open` — re-connect via QR in Evolution Manager |
| "Stored API key can't be decrypted" | `ENCRYPTION_KEY` changed between envs — click **Reset Configuration**, re-save |
| Messages never arrive | Webhook not configured — check `webhook_configured_at`; set `NEXT_PUBLIC_SITE_URL`; ensure tunnel/deploy is public HTTPS; confirm events enabled in the instance |
| Inbound works, no AI reply | Auto-reply off, key missing, agent assigned, reply cap hit, or an active message/keyword automation is standing the AI down |
| Media doesn't render | Confirm `chat-media` storage bucket is public and the migration created it; the webhook uses the service-role key to upload |
| Template save with image header fails | Evolution has no Resumable Upload — remove the image header (templates are local CRUD only) |
| 401 on webhook | `apikey` in the event body doesn't match the saved key |
| Webhook stops working after a tunnel restart | cloudflared URLs rotate — restart the tunnel, update `NEXT_PUBLIC_SITE_URL`, re-save the WhatsApp config (save re-sets the webhook) |

---

## 10. Quick reference — key files

| File | Role |
|---|---|
| `wacrm/src/lib/whatsapp/meta-api.ts` | Evolution API client (all outbound calls) |
| `wacrm/src/app/api/whatsapp/webhook/route.ts` | Inbound events + media ingestion + dispatch |
| `wacrm/src/app/api/whatsapp/config/route.ts` | Save/test/reset WhatsApp config + webhook setup |
| `wacrm/src/app/api/whatsapp/media/[mediaId]/route.ts` | On-demand media proxy |
| `wacrm/src/components/settings/whatsapp-config.tsx` | WhatsApp settings UI |
| `wacrm/src/components/settings/ai-config.tsx` | AI assistant UI (Gemini) |
| `wacrm/src/lib/ai/providers/gemini.ts` | Gemini provider |
| `wacrm/supabase/migrations/037_evolution_provider.sql` | Schema changes for Evolution + Gemini |
| `wacrm/.env.local.example` | Full env reference |
