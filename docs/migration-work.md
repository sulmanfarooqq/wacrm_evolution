# wacrm → Evolution API Migration — Work Completed

This document records **everything that was changed** to migrate the `wacrm` CRM
(Next.js 16 + Supabase) from the official Meta WhatsApp Cloud API to a
self-hosted **Evolution API** instance, and to switch the built-in AI assistant
to **Google Gemini**.

- Migration target: Evolution API v2.3.7, instance `evolution_exchange`
  (connected at `sulmanfarooqq923425034517@s.whatsapp.net`), base URL
  `https://evolution-api-production-3988.up.railway.app/`
- Current verification state: **typecheck ✔ · lint 0 errors ✔ · 631 tests pass ✔**

---

## 1. Design decisions (the "rules of the migration")

- **Drop-in rewrite of `src/lib/whatsapp/meta-api.ts`.** Every exported function
  kept its name + options-object shape so the ~20 importing files compile with
  minimal churn. Callers that have a per-account base URL only had to thread
  through an `apiBaseUrl` option.
- **Column reuse:** `phone_number_id` is reused as the Evolution **instance
  name**; `access_token` holds the AES-256-GCM-encrypted Evolution **API key**.
- **API key auth:** the Evolution key is sent as the `apikey` header (not
  `Authorization: Bearer`).
- **Outbound message id** is read from `data.key.id` (Evolution), NOT
  `data.messages[0].id` (Meta).
- **No Meta template approval flow** → `sendTemplateMessage` sends **free-form
  text** resolved from the local `template.body_text` with `{{N}}` substitution.
  Template submit/edit/delete are **local-only stubs**.
- **No HMAC / verify-token challenge.** The webhook is POST-only and is
  authenticated by the event body's `apikey` field (matched against the saved
  key). A missing `apikey` is tolerated; a mismatched one is rejected.
- **Inbound media** is downloaded on demand via
  `POST /chat/getBase64FromMediaMessage/{instance}` and persisted into the
  existing public `chat-media` bucket (`buildMediaPath`), so the frontend
  renders it with zero changes.
- **AI is always Gemini** (Google model), per the user's requirement.

---

## 2. The Evolution API client — `src/lib/whatsapp/meta-api.ts`

Full rewrite of the transport layer. Endpoints used:

| Endpoint (v2) | Purpose | Notes |
|---|---|---|
| `POST /message/sendText/{instance}` | Free-form text | body `{ number, text, quoted? }` → `{ key: { id } }` |
| `POST /message/sendMedia/{instance}` | Image/video/document/audio | body `{ number, mediatype, mimetype, caption?, fileName?, media }` |
| `POST /message/sendReaction/{instance}` | Reactions | body `{ key: { remoteJid, fromMe: false, id }, reaction }` |
| `POST /message/sendButtons/{instance}` | Up to 3 reply buttons | body `{ number, title, description, footer, buttons: [{ title:'reply', displayText, id }] }` |
| `POST /message/sendList/{instance}` | Tap-to-expand list | body `{ number, title, description, buttonText, footerText, values: [{ title, rows: [{ title, description, rowId }] }] }` |
| `GET /instance/connectionState/{instance}` | Verify + connection probe | → `{ instance: { state: 'open'\|'close', ownerJid } }` |
| `POST /webhook/set/{instance}` | Configure webhook | body `{ url, webhook_by_events:false, webhook_base64:false, events:[...] }` |
| `POST /chat/getBase64FromMediaMessage/{instance}` | Download inbound media | body `{ message: { key: { id } }, convertToMp4:false }` |

Key implementation details:

- `evolutionRequest()` — shared transport. Builds
  `${baseUrl}/${path.replace('{instance}', instanceName)}`, sends the `apikey`
  header, and surfaces a human-readable message from Evolution's error
  envelopes (`message` / `error` / `response`).
- `extractMessageId()` — reads the message id from `key.id` (with a fallback to
  `data.key.id`). Returns `''` when absent (e.g. the reaction endpoint only
  acknowledges).
- `guessMimeType()` — derives the MIME type from the URL/filename extension,
  falling back to a per-kind default. Audio drops both `caption` and `fileName`
  (Evolution returns 400 otherwise); only documents accept `fileName`.
- **Preserved exports (same signatures):** `sendTextMessage`, `sendMediaMessage`,
  `sendTemplateMessage`, `sendReactionMessage`, `sendInteractiveButtons`,
  `sendInteractiveList`, `verifyPhoneNumber`, `registerPhoneNumber`,
  `subscribeWabaToApp`, `getSubscribedApps`, `INTERACTIVE_LIMITS`.
- **New exports:** `getEvolutionConnectionState`, `setEvolutionWebhook`,
  `getEvolutionMediaBase64` + their args/result types.
- **Removed:** `getMediaUrl`, `downloadMedia`.
- **No-op stubs** (Evolution has no equivalent): `registerPhoneNumber`
  (`{ success:true, alreadyRegistered:false }`), `subscribeWabaToApp` (void),
  `getSubscribedApps` (`[]`).
- **Local-only stubs:** `submitMessageTemplate` (returns synthetic
  `local-<uuid>` id, status `APPROVED`), `editMessageTemplate`
  (`{ success:true }`), `deleteMessageTemplate` (void).
- **`uploadResumableMedia` throws** a clear error — Evolution has no Resumable
  Upload, so image-header templates can't create a media handle.
- `verifyPhoneNumber` now verifies the instance + key via
  `getEvolutionConnectionState` and throws a clear "not connected" error when
  the instance state isn't `open`.

### Interactive reply normalization

On Evolution, button replies arrive as
`message.buttonsResponseMessage.selectedButtonId` / `selectedDisplayText` and
list replies as `message.listResponseMessage.singleSelectReply.selectedRowId` /
`selectedRowTitle`. Both are normalized in the webhook to `type:'interactive'`
with `interactiveReplyId` / `interactiveReplyTitle` (the shape the flows engine
already understands).

---

## 3. Per-file change list

### 3.1 WhatsApp config + verification

- **`src/app/api/whatsapp/config/route.ts`** — rewritten for Evolution:
  - `POST` accepts `{ instance_name, access_token, api_base_url? }` (with
    `phone_number_id` accepted as an alias).
  - Verifies instance + API key via `verifyPhoneNumber` BEFORE saving.
  - Rejects an instance already claimed by another account (single-tenant per
    number).
  - Auto-configures the webhook (`setEvolutionWebhook`) pointing at
    `${appBaseUrl}/api/whatsapp/webhook` with events `MESSAGES_UPSERT`,
    `MESSAGES_UPDATE`, `CONNECTION_UPDATE`. Best-effort — a failed webhook set
    doesn't block saving, but records `webhook_configured_at` /
    `last_registration_error`.
  - `GET` — connection test + health check; returns
    `connected` / `token_corrupted` / `no_config` / `evolution_error` reasons.
  - `DELETE` — reset config (recovery from a corrupted encrypted token).
- **`src/app/api/whatsapp/config/verify-registration/route.ts`** — Evolution
  diagnostic probe: reports the checks performed, `webhook_configured_at`, and
  `connected_at`.

### 3.2 Webhook + media

- **`src/app/api/whatsapp/webhook/route.ts`** — full rewrite. POST-only (GET
  returns 405). Parses the Evolution event envelope
  (`event`, `instance`, `data`, `apikey`, …):
  - `messages.upsert` → normalizes Baileys-style payloads
    (`conversation`, `extendedTextMessage`, `imageMessage`, `videoMessage`,
    `documentMessage`, `audioMessage`, `stickerMessage`, `locationMessage`,
    `reactionMessage`, `buttonsResponseMessage`, `listResponseMessage`) into the
    existing inbound-message shape.
  - `messages.update` → status updates (messageId / remoteJid / status) mapped
    to the `sending|sent|delivered|read|failed` CHECK constraint via the
    forward-only transition ladder (`SERVER_ACK→sent`, `DELIVERY_ACK→delivered`,
    `READ→read`, `PLAYED→read`, `FAILED→failed`; `PENDING`/`DELETED` ignored).
  - `connection.update` → logs connection state.
  - Authenticates by comparing the event's `apikey` to the decrypted stored key
    (missing `apikey` tolerated).
  - Downloads inbound media via `getEvolutionMediaBase64` and uploads to
    `chat-media/account-<accountId>/<timestamp>-<basename>.<ext>` using the
    service-role client (bypasses RLS).
  - After persistence, fans out to the automation engine
    (`runAutomationsForTrigger`), the flows engine
    (`dispatchInboundToFlows`), AI auto-reply (`dispatchInboundToAiReply`), and
    outbound webhook delivery (`dispatchWebhookEvent`).
- **`src/app/api/whatsapp/media/[mediaId]/route.ts`** — on-demand media proxy;
  fetches base64 from Evolution and streams it back with the right content-type.

### 3.3 Sending paths (threaded `apiBaseUrl`)

- **`src/lib/whatsapp/send-message.ts`** — threads `apiBaseUrl` into
  `sendTemplateMessage` / `sendTextMessage`.
- **`src/app/api/whatsapp/react/route.ts`** — threads `apiBaseUrl` into
  `sendReactionMessage`.
- **`src/lib/automations/meta-send.ts`** — threads `apiBaseUrl` into
  `sendTemplateMessage` + `sendTextMessage`.
- **`src/lib/flows/meta-send.ts`** — threads `apiBaseUrl` into `sendTextMessage`,
  `sendMediaMessage`, `sendInteractiveButtons`, `sendInteractiveList`.
- **`src/app/api/whatsapp/broadcast/route.ts`** — threads `apiBaseUrl` into
  `sendTemplateMessage`.
- **`src/lib/whatsapp/broadcast-core.ts`** — `BroadcastPlan` gained
  `apiBaseUrl?: string`, populated from `config.api_base_url` in `createBroadcast`
  and passed through in `deliverBroadcast`.

### 3.4 Settings UI

- **`src/components/settings/whatsapp-config.tsx`** — rewritten from the
  Meta form to an Evolution form:
  - Fields: **Instance Name**, **API Base URL** (root-URL hint), **API Key**
    (masked). Webhook URL display with copy button retained.
  - `isRegistered` → `isWebhookConfigured` (driven by `webhook_configured_at`).
  - Setup instructions rewritten for the Evolution Manager (QR connect, global
    API key, webhook events).
  - "Verify setup" hits `/api/whatsapp/config/verify-registration`; the probe
    shows checks, `webhook_configured_at`, `connected_at`.
  - Doc link → `https://doc.evolution-api.com/v2/en/get-started/introduction`.

### 3.5 Types + translations

- **`src/types/index.ts`** — `WhatsAppConfig` gained `provider?`,
  `instance_name?`, `api_base_url?`, `webhook_configured_at?`;
  `registered_at?` / `subscribed_apps_at?` kept (legacy, unused for Evolution).
- **`messages/en.json` + `messages/ko.json`** — `Settings.whatsapp` block
  rewritten for Evolution (`instanceName`, `instanceNamePlaceholder`,
  `apiBaseUrl`, `apiBaseUrlPlaceholder`, `apiBaseUrlHint`, `evolutionDocs`, …);
  Meta-specific keys removed (`tokenCorrupted`, `phoneNumberId`, `wabaId`,
  `webhookVerifyToken`, `twoStepPin`, `pinHint`, `metaDocs`, …). Both files
  validated as JSON.

### 3.6 AI assistant — Gemini

- **`src/lib/ai/providers/gemini.ts`** (new) — calls
  `https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent`
  with the `x-goog-api-key` header; maps conversation roles `user`/`assistant`
  → Gemini `user`/`model`; parses `candidates[0].content.parts`; usage from
  `usageMetadata`.
- **`src/lib/ai/types.ts`** — `AiProvider` widened to
  `'openai' | 'anthropic' | 'gemini'`.
- **`src/lib/ai/defaults.ts`** — `gemini: 'gemini-2.5-flash'` added to
  `AI_PROVIDER_DEFAULT_MODEL` (the current stable GA model).
- **`src/lib/ai/generate.ts`** — added the `case 'gemini'` dispatch.
- **`src/lib/ai/config.ts`** — `AiConfigRow.provider` widened to `AiProvider`.
- **`src/app/api/ai/config/route.ts` + `src/app/api/ai/test/route.ts`** —
  `'gemini'` allowed in the provider whitelist.
- **`src/components/settings/ai-config.tsx`** — `PROVIDER_LABEL` +
  `KEY_PLACEHOLDER` include Gemini; **default provider is now `'gemini'`** with
  default model `gemini-2.5-flash`; Gemini listed first in the provider select.
- **`src/lib/ai/generate.test.ts`** — added Gemini tests (endpoint, header,
  role mapping, auth-error mapping).

### 3.7 Environment template

- **`.env.local.example`** — removed required `META_APP_SECRET`; added optional
  `EVOLUTION_API_URL` / `EVOLUTION_API_KEY` defaults; documented that the
  inbound webhook is token-authenticated (no HMAC / verify token);
  `META_APP_ID` section marked as unused; AI section notes Gemini as the
  bring-your-own-key default.

### 3.8 Database migration

- **`supabase/migrations/037_evolution_provider.sql`** (new, idempotent):
  - `whatsapp_config` gains `provider` (default `'meta'`), `instance_name`,
    `api_base_url`, `webhook_configured_at`; index on `instance_name`.
  - Rebuilds the `ai_configs.provider` CHECK to allow `'gemini'`.

### 3.9 Tests rewritten against the Evolution wire shapes

- **`meta-api.test.ts`** — asserts `message/sendButtons/{instance}` +
  `message/sendList/{instance}` payloads (`number/title/description/footer/
  buttons`, `buttonText/values/rowId`) and the `key.id` response; validation
  tests unchanged (still pre-network).
- **`meta-api.media.test.ts`** — asserts `message/sendMedia/{instance}`
  (`mediatype/mimetype/media/caption/fileName`) + `key.id` response.
- **`meta-api.resumable.test.ts`** — asserts `uploadResumableMedia` throws the
  clear Evolution error and never calls fetch.
- **`registration.test.ts`** — asserts the register / subscribe /
  get-subscribed-apps no-ops resolve locally without calling fetch.
- **`template-lifecycle.test.ts`** — asserts the submit/edit/delete local stubs
  (synthetic `local-<uuid>` APPROVED id; `{ success:true }`; void; no fetch).

---

## 4. Verified green

```
npm run typecheck  → pass (0 errors)
npm run lint       → 0 errors (38 pre-existing warnings)
npm test           → 66 files, 631 tests passed
```

---

## 5. Known limitations (by design)

- **Templates are local CRUD only** — Evolution has no Meta approval flow.
  Template submit/edit/delete never touch the network. Creating a template with
  an **image header** fails (`uploadResumableMedia` throws) — remove the image
  header to save templates locally.
- **Groups (`@g.us`) are skipped** on inbound — v1 is contact-DM only.
- **Per-account single instance** — one `whatsapp_config` row per account, one
  instance per row (enforced on save).
- **`PLAYED` (voice-note played) maps to `read`** — there is no `played` value in
  the messages CHECK constraint.
- The Meta template webhook/send-builder/validator/component modules remain in
  the codebase but are **unreferenced** by the new code paths (they compile,
  they're just dead for Evolution).
