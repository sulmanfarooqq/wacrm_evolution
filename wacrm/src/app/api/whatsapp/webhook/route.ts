import { NextResponse, after } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { decrypt } from '@/lib/whatsapp/encryption'
import { getEvolutionMediaBase64 } from '@/lib/whatsapp/meta-api'
import { normalizePhone } from '@/lib/whatsapp/phone-utils'
import { findExistingContact, isUniqueViolation } from '@/lib/contacts/dedupe'
import { runAutomationsForTrigger } from '@/lib/automations/engine'
import { dispatchInboundToFlows } from '@/lib/flows/engine'
import { dispatchInboundToAiReply } from '@/lib/ai/auto-reply'
import { dispatchWebhookEvent } from '@/lib/webhooks/deliver'
import { buildMediaPath } from '@/lib/storage/upload-media'

// The `after()` callback in POST runs within this route's max duration.
// Inbound processing can fan out to per-media download + upload calls, so
// give it headroom beyond the platform default (Vercel clamps this to the
// plan's ceiling). Tune as needed.
export const maxDuration = 60

// Lazy-initialized to avoid build-time crash when env vars are missing
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _adminClient: any = null
function supabaseAdmin() {
  if (!_adminClient) {
    _adminClient = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!
    )
  }
  return _adminClient
}

/**
 * The what a single Evolution event needs to persist an inbound message:
 * the matched whatsapp_config row's tenancy + audit columns plus the
 * decrypted instance credentials used for media downloads.
 */
interface WebhookConfig {
  accountId: string
  configOwnerUserId: string
  accessToken: string
  instanceName: string
  apiBaseUrl?: string
}

/**
 * A normalized inbound message, translated from Evolution's Baileys
 * payload into the shapes the persistence + engines already understand.
 */
interface InboundMessage {
  id: string
  /** Sender phone — digits only, `@s.whatsapp.net` already stripped. */
  from: string
  /** Seconds since epoch, as a string (matches the old Meta shape). */
  timestamp: string
  pushName: string
  type:
    | 'text'
    | 'image'
    | 'video'
    | 'document'
    | 'audio'
    | 'sticker'
    | 'location'
    | 'interactive'
    | 'reaction'
  text?: string
  media?: {
    messageId: string
    mimeType?: string
    fileName?: string
    caption?: string
  }
  location?: {
    latitude: number
    longitude: number
    name?: string
    address?: string
  }
  reaction?: { messageId: string; emoji: string }
  interactiveReplyId?: string
  interactiveReplyTitle?: string
  /** The id of the message this one quotes (swipe-reply). */
  replyToMessageId?: string
}

// ============================================================
// Status updates (messages.update)
// ============================================================
//
// Evolution delivers delivery/read receipts on the MESSAGES_UPDATE
// event. Its statuses map onto the messages + broadcast_recipients
// CHECK constraints:
//   SERVER_ACK    → sent        (message reached WhatsApp)
//   DELIVERY_ACK  → delivered   (reached the recipient's device)
//   READ          → read
//   PLAYED        → read        (voice note played counts as read)
//   FAILED        → failed
// PENDING / DELETED are skipped — they aren't useful transitions.

const EVOLUTION_STATUS_MAP: Record<string, string> = {
  SERVER_ACK: 'sent',
  DELIVERY_ACK: 'delivered',
  READ: 'read',
  PLAYED: 'read',
  FAILED: 'failed',
}

// The happy-path status ladder — pending → sent → delivered → read →
// replied. Webhook replays must never regress a recipient back down
// this ladder.
//
// `failed` is NOT on this ladder. It's a terminal side branch that is
// only valid from the early states (pending / sent) — once the message
// has been delivered or read, a later "failed" status event is a bug or
// a spoof attempt and must be ignored.
const RECIPIENT_STATUS_LADDER = [
  'pending',
  'sent',
  'delivered',
  'read',
  'replied',
] as const

function ladderLevel(s: string): number {
  const idx = (RECIPIENT_STATUS_LADDER as readonly string[]).indexOf(s)
  return idx < 0 ? -1 : idx
}

/**
 * Can a recipient transition from `current` to `incoming`?
 *   - Along the ladder, only forward moves are allowed.
 *   - `failed` is accepted only from `pending` or `sent`; it's refused
 *     once the recipient has reached any of the success states.
 */
function isValidStatusTransition(current: string, incoming: string): boolean {
  if (incoming === 'failed') {
    return current === 'pending' || current === 'sent'
  }
  if (current === 'failed') {
    return false // failed is terminal
  }
  const ci = ladderLevel(current)
  const ii = ladderLevel(incoming)
  if (ii < 0) return false // unknown incoming status
  if (ci < 0) return true // unknown current — accept anything on the ladder
  return ii > ci
}

async function handleStatusUpdate(status: { id: string; status: string }) {
  // 1) Mirror onto messages (legacy behavior). No `.select()`:
  // message_id is NOT unique (migration 009 — message ids repeat
  // across numbers), so this updates 0..N rows and must not assume a
  // single row.
  const { error: msgErr } = await supabaseAdmin()
    .from('messages')
    .update({ status: status.status })
    .eq('message_id', status.id)

  if (msgErr) {
    console.error('Error updating message status:', msgErr)
  }

  // Webhook fan-out for this status change happens at the END of this
  // handler (after the broadcast mirror below), so a slow subscriber
  // endpoint can't delay the broadcast_recipients update.

  // 2) Mirror onto broadcast_recipients via whatsapp_message_id
  //    (added in migration 003). The aggregate trigger on
  //    broadcast_recipients re-derives the parent broadcast's
  //    sent/delivered/read/failed counts automatically.
  const tsIso = new Date().toISOString()

  const { data: recipient, error: recFetchErr } = await supabaseAdmin()
    .from('broadcast_recipients')
    .select('id, status')
    .eq('whatsapp_message_id', status.id)
    .maybeSingle()

  if (recFetchErr) {
    console.error('Error fetching broadcast recipient:', recFetchErr)
  } else if (
    recipient &&
    // Guard transitions — forward-only on the success ladder, and
    // `failed` only from pre-delivered states.
    isValidStatusTransition(recipient.status, status.status)
  ) {
    const update: Record<string, unknown> = { status: status.status }
    if (status.status === 'sent') update.sent_at = tsIso
    if (status.status === 'delivered') update.delivered_at = tsIso
    if (status.status === 'read') update.read_at = tsIso

    const { error: recUpdateErr } = await supabaseAdmin()
      .from('broadcast_recipients')
      .update(update)
      .eq('id', recipient.id)

    if (recUpdateErr) {
      console.error('Error updating broadcast recipient status:', recUpdateErr)
    }
  }

  // 3) Webhook fan-out for messages we store (inbox / API sends).
  //    Runs last so a slow subscriber can't delay the mirrors above.
  //    Bounded to one row (message_id isn't unique) purely to resolve
  //    the owning account for delivery.
  const { data: msgRow } = await supabaseAdmin()
    .from('messages')
    .select('conversation_id, conversations(account_id)')
    .eq('message_id', status.id)
    .limit(1)
    .maybeSingle()

  if (msgRow) {
    const conv = msgRow.conversations as { account_id: string } | null
    const accountId = conv?.account_id
    if (accountId) {
      await dispatchWebhookEvent(
        supabaseAdmin(),
        accountId,
        'message.status_updated',
        {
          whatsapp_message_id: status.id,
          conversation_id: msgRow.conversation_id,
          status: status.status,
        }
      )
    }
  }
}

// ============================================================
// Connection updates (connection.update)
// ============================================================

async function handleConnectionUpdate(state: unknown, instanceName: string) {
  if (state !== 'open' && state !== 'close') return
  const update: Record<string, unknown> = { updated_at: new Date().toISOString() }
  if (state === 'open') {
    update.status = 'connected'
    update.connected_at = new Date().toISOString()
    update.last_registration_error = null
  } else {
    update.status = 'disconnected'
  }
  const { error } = await supabaseAdmin()
    .from('whatsapp_config')
    .update(update)
    .eq('phone_number_id', instanceName)
  if (error) {
    console.error('[webhook] connection.update persist failed:', error.message)
  }
}

// ============================================================
// POST — receive events
// ============================================================

// Evolution never calls a hub.challenge GET — the webhook is configured
// by POST /webhook/set and authenticated by the embedded apikey.
export async function GET() {
  return NextResponse.json({ error: 'Method Not Allowed' }, { status: 405 })
}

export async function POST(request: Request) {
  let body: {
    event?: string
    instance?: string
    apikey?: string
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    data?: any
  }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const event = body.event
  const instanceName = typeof body.instance === 'string' ? body.instance : ''
  if (!event || !instanceName) {
    return NextResponse.json({ error: 'Missing event or instance' }, { status: 400 })
  }

  // Resolve the owning whatsapp_config by instance name. phone_number_id
  // holds the Evolution instance name post-migration-037.
  const { data: configRows, error: configError } = await supabaseAdmin()
    .from('whatsapp_config')
    .select('*')
    .eq('phone_number_id', instanceName)

  if (configError) {
    console.error(
      'Error fetching whatsapp_config for instance:',
      instanceName,
      configError
    )
    return NextResponse.json({ status: 'error' }, { status: 500 })
  }

  if (!configRows || configRows.length === 0) {
    console.error('No config found for Evolution instance:', instanceName)
    return NextResponse.json({ status: 'received' }, { status: 200 })
  }

  if (configRows.length > 1) {
    console.error(
      `Multiple configs (${configRows.length}) found for instance:`,
      instanceName,
      '— inbound event dropped. Resolve duplicates so each instance maps to a single account.'
    )
    return NextResponse.json({ status: 'received' }, { status: 200 })
  }

  const config = configRows[0]

  // Authenticate the event by its embedded apikey (Evolution includes
  // the instance's API key on every delivery). When present it must
  // match our stored key — otherwise anyone who learns an instance
  // name could inject fake messages.
  if (typeof body.apikey === 'string' && body.apikey) {
    let decryptedKey: string
    try {
      decryptedKey = decrypt(config.access_token)
    } catch {
      return NextResponse.json({ error: 'Invalid signature' }, { status: 401 })
    }
    if (body.apikey !== decryptedKey) {
      console.warn('[webhook] rejected event with mismatched apikey for instance', instanceName)
      return NextResponse.json({ error: 'Invalid signature' }, { status: 401 })
    }
  }

  // Process AFTER the response so we ack Evolution within their timeout
  // (a slow ack triggers retries + duplicate inserts), while still
  // guaranteeing the work runs to completion.
  //
  // This MUST use `after()` rather than a detached promise: on
  // serverless platforms (we run on Vercel) the function can be frozen
  // the moment the response is sent, so a floating promise's DB writes
  // are not guaranteed to finish. `after()` hands the callback to the
  // runtime, which keeps the function alive until it resolves (within
  // the route's maxDuration).
  after(async () => {
    try {
      await processEvent(event, body.data, {
        accountId: config.account_id,
        configOwnerUserId: config.user_id,
        accessToken: decrypt(config.access_token),
        instanceName,
        apiBaseUrl: config.api_base_url ?? undefined,
      })
    } catch (error) {
      console.error('[webhook] error processing event:', error)
    }
  })

  return NextResponse.json({ status: 'received' }, { status: 200 })
}

async function processEvent(
  event: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  data: any,
  config: WebhookConfig
): Promise<void> {
  switch (event) {
    case 'messages.upsert':
      await handleIncomingMessage(data, config)
      break
    case 'messages.update':
      await handleMessageUpdate(data)
      break
    case 'connection.update':
      await handleConnectionUpdate(data?.state, config.instanceName)
      break
    default:
      // Unknown / irrelevant events (e.g. qrcode.updated, session.update,
      // call events) are ack'd and ignored.
      break
  }
}

async function handleMessageUpdate(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  data: any
): Promise<void> {
  if (!data || typeof data !== 'object') return

  // Evolution's messages.update payload carries the message id in
  // `messageId` (newer) or `key.id` / `keyId` (older versions).
  const id =
    typeof data.messageId === 'string'
      ? data.messageId
      : typeof data.keyId === 'string'
        ? data.keyId
        : typeof data.key?.id === 'string'
          ? data.key.id
          : ''
  if (!id) return

  const rawStatus = typeof data.status === 'string' ? data.status : ''
  const mapped = EVOLUTION_STATUS_MAP[rawStatus]
  if (!mapped) return // PENDING / DELETED / unknown — not a useful transition

  await handleStatusUpdate({ id, status: mapped })
}

async function handleIncomingMessage(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  data: any,
  config: WebhookConfig
): Promise<void> {
  const message = normalizeInboundMessage(data)
  if (!message) return

  await processMessage(message, config)
}

/**
 * Translate Evolution's Baileys message payload into the normalized
 * InboundMessage shape. Returns null for events that don't represent a
 * new customer message: our own sends (fromMe), group chats, reactions
 * delivered as their own event, or unknown payloads.
 */
function normalizeInboundMessage(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  data: any
): InboundMessage | null {
  if (!data || typeof data !== 'object') return null
  const key = data.key ?? {}
  if (key.fromMe) return null

  const remoteJid = typeof key.remoteJid === 'string' ? key.remoteJid : ''
  // v1 scope: individual chats only.
  if (!remoteJid || remoteJid.endsWith('@g.us')) return null

  const id = typeof key.id === 'string' ? key.id : ''
  if (!id) return null

  const from = normalizePhone(remoteJid.replace(/@s\.whatsapp\.net$/, ''))
  const timestamp =
    typeof data.messageTimestamp === 'number'
      ? String(data.messageTimestamp)
      : String(Math.floor(Date.now() / 1000))
  const pushName = typeof data.pushName === 'string' ? data.pushName : ''
  const msg = data.message ?? {}

  const contextInfo =
    msg.extendedTextMessage?.contextInfo ??
    msg.imageMessage?.contextInfo ??
    msg.videoMessage?.contextInfo ??
    msg.documentMessage?.contextInfo ??
    msg.audioMessage?.contextInfo ??
    null
  const replyToMessageId =
    typeof contextInfo?.stanzaId === 'string' ? contextInfo.stanzaId : undefined

  const base = { id, from, timestamp, pushName, replyToMessageId }

  if (typeof msg.conversation === 'string' && msg.conversation.length > 0) {
    return { ...base, type: 'text', text: msg.conversation }
  }
  if (typeof msg.extendedTextMessage?.text === 'string') {
    return { ...base, type: 'text', text: msg.extendedTextMessage.text }
  }
  if (msg.imageMessage) {
    const m = msg.imageMessage
    return {
      ...base,
      type: 'image',
      text: m.caption,
      media: {
        messageId: id,
        mimeType: m.mimetype,
        fileName: m.fileName,
        caption: m.caption,
      },
    }
  }
  if (msg.videoMessage) {
    const m = msg.videoMessage
    return {
      ...base,
      type: 'video',
      text: m.caption,
      media: {
        messageId: id,
        mimeType: m.mimetype,
        fileName: m.fileName,
        caption: m.caption,
      },
    }
  }
  if (msg.documentMessage) {
    const m = msg.documentMessage
    return {
      ...base,
      type: 'document',
      text: m.caption || m.fileName,
      media: {
        messageId: id,
        mimeType: m.mimetype,
        fileName: m.fileName,
        caption: m.caption,
      },
    }
  }
  if (msg.audioMessage) {
    const m = msg.audioMessage
    return {
      ...base,
      type: 'audio',
      media: { messageId: id, mimeType: m.mimetype },
    }
  }
  if (msg.stickerMessage) {
    const m = msg.stickerMessage
    return {
      ...base,
      type: 'sticker',
      media: { messageId: id, mimeType: m.mimetype, fileName: m.fileName },
    }
  }
  if (msg.locationMessage) {
    const m = msg.locationMessage
    return {
      ...base,
      type: 'location',
      location: {
        latitude: typeof m.degreesLatitude === 'number' ? m.degreesLatitude : 0,
        longitude: typeof m.degreesLongitude === 'number' ? m.degreesLongitude : 0,
        name: m.name,
        address: m.address,
      },
    }
  }
  if (msg.reactionMessage) {
    const r = msg.reactionMessage
    const target = typeof r.key?.id === 'string' ? r.key.id : ''
    return {
      ...base,
      type: 'reaction',
      reaction: { messageId: target, emoji: typeof r.text === 'string' ? r.text : '' },
    }
  }
  if (msg.buttonsResponseMessage) {
    const b = msg.buttonsResponseMessage
    const replyId = typeof b.selectedButtonId === 'string' ? b.selectedButtonId : ''
    const title = typeof b.selectedDisplayText === 'string' ? b.selectedDisplayText : replyId
    return {
      ...base,
      type: 'interactive',
      text: title,
      interactiveReplyId: replyId || undefined,
      interactiveReplyTitle: title,
    }
  }
  if (msg.listResponseMessage) {
    const l = msg.listResponseMessage
    const row = l.singleSelectReply ?? {}
    const replyId = typeof row.selectedRowId === 'string' ? row.selectedRowId : ''
    const title =
      typeof row.selectedRowTitle === 'string'
        ? row.selectedRowTitle
        : typeof l.title === 'string'
          ? l.title
          : replyId
    return {
      ...base,
      type: 'interactive',
      text: title,
      interactiveReplyId: replyId || undefined,
      interactiveReplyTitle: title,
    }
  }

  // Unsupported payload (contacts array, protocol messages, etc.) —
  // nothing useful to persist.
  return null
}

/**
 * Fetch an inbound media message's bytes from the instance and upload
 * them into the public `chat-media` bucket so the inbox renders the
 * attachment from its public URL. Returns the public URL, or null when
 * the download/upload fails (message still persists, without media).
 */
async function storeInboundMedia(
  messageId: string,
  config: WebhookConfig
): Promise<string | null> {
  try {
    const media = await getEvolutionMediaBase64({
      phoneNumberId: config.instanceName,
      accessToken: config.accessToken,
      apiBaseUrl: config.apiBaseUrl,
      messageId,
    })
    if (!media.base64) {
      console.warn(`[webhook] getBase64FromMediaMessage returned empty base64 for ${messageId}`)
      return null
    }
    const bytes = Buffer.from(media.base64, 'base64')
    if (bytes.byteLength === 0) {
      console.warn(`[webhook] media ${messageId} decoded to 0 bytes`)
      return null
    }

    const fileName = media.fileName || `media-${messageId}`
    const mimeType = media.mimetype || 'application/octet-stream'
    const path = buildMediaPath(config.accountId, fileName)

    const { error: upErr } = await supabaseAdmin()
      .storage.from('chat-media')
      .upload(path, bytes, { contentType: mimeType, upsert: false })

    if (upErr) {
      console.error(`[webhook] chat-media upload failed for ${messageId}:`, upErr.message)
      return null
    }

    const {
      data: { publicUrl },
    } = supabaseAdmin().storage.from('chat-media').getPublicUrl(path)
    return publicUrl
  } catch (err) {
    console.error(
      `[webhook] inbound media download failed for ${messageId}:`,
      err instanceof Error ? err.message : err
    )
    return null
  }
}

/**
 * If an inbound message's sender is on a still-unreplied
 * broadcast_recipients row, flip it to `replied` so the reply count
 * advances on the parent broadcast.
 *
 * Runs on a best-effort basis — failures here must not break the
 * main inbound-message flow, so errors are swallowed with a log.
 */
async function flagBroadcastReplyIfAny(accountId: string, contactId: string) {
  try {
    // Most recent outbound broadcast in this account that hasn't
    // been replied to yet. Account-scoped so a shared inbox reply
    // marks the broadcast as replied regardless of which teammate
    // sent it.
    const { data: recs, error } = await supabaseAdmin()
      .from('broadcast_recipients')
      .select('id, status, broadcast_id, broadcasts!inner(account_id)')
      .eq('contact_id', contactId)
      .eq('broadcasts.account_id', accountId)
      .in('status', ['sent', 'delivered', 'read'])
      .order('created_at', { ascending: false })
      .limit(1)

    if (error || !recs || recs.length === 0) return

    const row = recs[0]
    const { error: updErr } = await supabaseAdmin()
      .from('broadcast_recipients')
      .update({ status: 'replied', replied_at: new Date().toISOString() })
      .eq('id', row.id)

    if (updErr) {
      console.error('Error marking broadcast recipient replied:', updErr)
    }
  } catch (err) {
    console.error('flagBroadcastReplyIfAny failed:', err)
  }
}

/**
 * Resolve an instance-side message_id into the matching internal UUID,
 * scoped to one conversation. Returns null when we never received the
 * parent (e.g. a swipe-reply to a message older than this CRM install).
 */
async function lookupInternalIdByMetaId(
  metaId: string,
  conversationId: string
): Promise<string | null> {
  const { data, error } = await supabaseAdmin()
    .from('messages')
    .select('id')
    .eq('message_id', metaId)
    .eq('conversation_id', conversationId)
    .maybeSingle()
  if (error) {
    console.error('[webhook] lookupInternalIdByMetaId failed:', error.message)
    return null
  }
  return data?.id ?? null
}

/**
 * Persist an inbound reaction. WhatsApp reactions are not new messages —
 * they're per-(target, actor) state. We upsert / delete on
 * `message_reactions`, never write a row into `messages`.
 *
 * Best-effort: a missing parent (we never received it) is logged and
 * skipped so the webhook still acks 200 to Evolution.
 */
async function handleReaction(
  message: InboundMessage,
  conversationId: string,
  contactId: string
) {
  const reaction = message.reaction
  if (!reaction?.messageId) return

  const targetInternalId = await lookupInternalIdByMetaId(
    reaction.messageId,
    conversationId
  )
  if (!targetInternalId) {
    console.warn(
      '[webhook] reaction target message not found; skipping',
      reaction.messageId
    )
    return
  }

  // Empty emoji = removal.
  if (!reaction.emoji) {
    const { error: delError } = await supabaseAdmin()
      .from('message_reactions')
      .delete()
      .eq('message_id', targetInternalId)
      .eq('actor_type', 'customer')
      .eq('actor_id', contactId)
    if (delError) {
      console.error('[webhook] reaction delete failed:', delError.message)
    }
    return
  }

  const { error: upsertError } = await supabaseAdmin()
    .from('message_reactions')
    .upsert(
      {
        message_id: targetInternalId,
        conversation_id: conversationId,
        actor_type: 'customer',
        actor_id: contactId,
        emoji: reaction.emoji,
      },
      { onConflict: 'message_id,actor_type,actor_id' }
    )
  if (upsertError) {
    console.error('[webhook] reaction upsert failed:', upsertError.message)
  }
}

async function processMessage(message: InboundMessage, config: WebhookConfig) {
  const senderPhone = message.from
  const contactName = message.pushName

  // Find or create contact
  const contactOutcome = await findOrCreateContact(
    config.accountId,
    config.configOwnerUserId,
    senderPhone,
    contactName
  )
  if (!contactOutcome) return
  const contactRecord = contactOutcome.contact

  // Find or create conversation
  const convResult = await findOrCreateConversation(
    config.accountId,
    config.configOwnerUserId,
    contactRecord.id
  )
  if (!convResult) return
  const conversation = convResult.conversation

  // Emit conversation.created as soon as the thread is opened — BEFORE
  // the reaction short-circuit below — so a conversation first opened by
  // a reaction still fires the event.
  if (convResult.created) {
    await dispatchWebhookEvent(supabaseAdmin(), config.accountId, 'conversation.created', {
      conversation_id: conversation.id,
      contact_id: contactRecord.id,
    })
  }

  // Reactions short-circuit here — they aren't messages.
  if (message.type === 'reaction') {
    await handleReaction(message, conversation.id, contactRecord.id)
    return
  }

  // Resolve the content — for media this downloads from the instance
  // and uploads to chat-media (returns the public URL).
  const { contentText, mediaUrl } = await resolveMessageContent(message, config)

  // Resolve swipe-reply context if present. A missing parent is fine —
  // we just store NULL and the UI renders the message without a quote.
  let replyToInternalId: string | null = null
  if (message.replyToMessageId) {
    replyToInternalId = await lookupInternalIdByMetaId(
      message.replyToMessageId,
      conversation.id
    )
    if (!replyToInternalId) {
      console.warn(
        '[webhook] reply context parent not found:',
        message.replyToMessageId
      )
    }
  }

  const interactiveReplyId = message.interactiveReplyId ?? null

  // The messages.content_type CHECK constraint allows:
  //   text, image, document, audio, video, location, template, interactive
  const ALLOWED_CONTENT_TYPES = new Set([
    'text', 'image', 'document', 'audio', 'video',
    'location', 'template', 'interactive',
  ])
  const contentType = ALLOWED_CONTENT_TYPES.has(message.type)
    ? message.type
    : message.type === 'sticker'
      ? 'image'   // stickers are images
      : 'text'    // unknown → text fallback

  // Determine whether this is the contact's very first inbound message
  // BEFORE we insert, so the count is accurate.
  const { count: priorCustomerMsgCount } = await supabaseAdmin()
    .from('messages')
    .select('id', { count: 'exact', head: true })
    .eq('conversation_id', conversation.id)
    .eq('sender_type', 'customer')
  const isFirstInboundMessage = (priorCustomerMsgCount ?? 0) === 0

  const { error: msgError } = await supabaseAdmin().from('messages').insert({
    conversation_id: conversation.id,
    sender_type: 'customer',
    content_type: contentType,
    content_text: contentText,
    media_url: mediaUrl,
    message_id: message.id,
    status: 'delivered',
    created_at: new Date(parseInt(message.timestamp) * 1000).toISOString(),
    reply_to_message_id: replyToInternalId,
    interactive_reply_id: interactiveReplyId,
  })

  if (msgError) {
    console.error('Error inserting message:', msgError)
    return
  }

  // Update conversation
  const { error: convError } = await supabaseAdmin()
    .from('conversations')
    .update({
      last_message_text: contentText || `[${message.type}]`,
      last_message_at: new Date().toISOString(),
      unread_count: (conversation.unread_count || 0) + 1,
      updated_at: new Date().toISOString(),
    })
    .eq('id', conversation.id)

  if (convError) {
    console.error('Error updating conversation:', convError)
  }

  // If this contact was a recent broadcast recipient, flag the reply
  // so the broadcast's `replied_count` advances (via the aggregate
  // trigger installed in migration 003).
  await flagBroadcastReplyIfAny(config.accountId, contactRecord.id)

  // ============================================================
  // Flow runner dispatch.
  //
  // If the runner consumes the message (it either advanced an active
  // run or started a new one), we suppress the `new_message_received`
  // + `keyword_match` automation triggers for this inbound.
  //
  // The relationship-level triggers (`new_contact_created`,
  // `first_inbound_message`) still fire even when consumed.
  // ============================================================
  const flowResult = await dispatchInboundToFlows({
    accountId: config.accountId,
    userId: config.configOwnerUserId,
    contactId: contactRecord.id,
    conversationId: conversation.id,
    message:
      interactiveReplyId
        ? {
            kind: 'interactive_reply',
            reply_id: interactiveReplyId,
            reply_title: contentText ?? message.interactiveReplyTitle ?? '',
            meta_message_id: message.id,
          }
        : {
            kind: 'text',
            text: contentText ?? message.text ?? '',
            meta_message_id: message.id,
          },
    isFirstInboundMessage,
  })
  const flowConsumed = flowResult.consumed

  // Fire any automations that react to this webhook event.
  const inboundText = contentText ?? message.text ?? ''
  const automationTriggers: (
    | 'new_contact_created'
    | 'first_inbound_message'
    | 'new_message_received'
    | 'keyword_match'
    | 'interactive_reply'
  )[] = []
  if (!flowConsumed) {
    automationTriggers.push('new_message_received', 'keyword_match')
    if (interactiveReplyId) {
      automationTriggers.push('interactive_reply')
    }
  }
  if (contactOutcome.wasCreated) automationTriggers.unshift('new_contact_created')
  if (isFirstInboundMessage) automationTriggers.unshift('first_inbound_message')
  for (const triggerType of automationTriggers) {
    runAutomationsForTrigger({
      accountId: config.accountId,
      triggerType,
      contactId: contactRecord.id,
      context: {
        message_text: inboundText,
        conversation_id: conversation.id,
        interactive_reply_id: interactiveReplyId ?? undefined,
      },
    }).catch((err) => console.error('[automations] dispatch failed:', err))
  }

  // AI auto-reply. Runs only for plain-text inbound the deterministic
  // flow runner did NOT consume, and only when the account has enabled
  // it.
  if (!flowConsumed && !interactiveReplyId && inboundText.trim()) {
    await dispatchInboundToAiReply({
      accountId: config.accountId,
      conversationId: conversation.id,
      contactId: contactRecord.id,
      configOwnerUserId: config.configOwnerUserId,
    })
  }

  // message.received webhook (public API).
  await dispatchWebhookEvent(supabaseAdmin(), config.accountId, 'message.received', {
    conversation_id: conversation.id,
    contact_id: contactRecord.id,
    whatsapp_message_id: message.id,
    content_type: contentType,
    text: contentText,
  })
}

/**
 * Resolve an inbound message's content. Media types fetch the bytes
 * from the instance and upload them to the public chat-media bucket,
 * returning the public URL (or null on failure).
 */
async function resolveMessageContent(
  message: InboundMessage,
  config: WebhookConfig
): Promise<{ contentText: string | null; mediaUrl: string | null }> {
  switch (message.type) {
    case 'image':
    case 'video':
    case 'document':
    case 'audio':
    case 'sticker': {
      if (!message.media?.messageId) {
        return { contentText: message.text ?? null, mediaUrl: null }
      }
      const mediaUrl = await storeInboundMedia(message.media.messageId, config)
      return { contentText: message.text ?? null, mediaUrl }
    }
    case 'location': {
      if (message.location) {
        const loc = message.location
        const locationText = [loc.name, loc.address, `${loc.latitude},${loc.longitude}`]
          .filter(Boolean)
          .join(' - ')
        return { contentText: locationText, mediaUrl: null }
      }
      return { contentText: null, mediaUrl: null }
    }
    default:
      return { contentText: message.text ?? null, mediaUrl: null }
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ContactRow = any

interface ContactOutcome {
  contact: ContactRow
  /** True when this call created the row; drives new_contact_created
   *  automation dispatch in processMessage. */
  wasCreated: boolean
}

async function findOrCreateContact(
  accountId: string,
  configOwnerUserId: string,
  phone: string,
  name: string
): Promise<ContactOutcome | null> {
  // Find an existing contact for this account by phone. The shared
  // helper pre-filters in SQL by the last-8-digit suffix (so we don't
  // pull every contact on every inbound message) then applies the
  // strict `phonesMatch` in JS on the small candidate set.
  const existingContact = await findExistingContact(
    supabaseAdmin(),
    accountId,
    phone,
  )

  if (existingContact) {
    // Update name if it changed
    if (name && name !== existingContact.name) {
      await supabaseAdmin()
        .from('contacts')
        .update({ name, updated_at: new Date().toISOString() })
        .eq('id', existingContact.id)
    }
    return { contact: existingContact, wasCreated: false }
  }

  // Create new contact. account_id is the tenancy column;
  // user_id is the NOT NULL FK audit column.
  const { data: newContact, error: createError } = await supabaseAdmin()
    .from('contacts')
    .insert({
      account_id: accountId,
      user_id: configOwnerUserId,
      phone,
      name: name || phone,
    })
    .select()
    .single()

  if (createError) {
    // Lost a race: a concurrent inbound delivery created this contact
    // between our lookup and insert. Re-resolve instead of dropping.
    if (isUniqueViolation(createError)) {
      const raced = await findExistingContact(supabaseAdmin(), accountId, phone)
      if (raced) return { contact: raced, wasCreated: false }
    }
    console.error('Error creating contact:', createError)
    return null
  }

  return { contact: newContact, wasCreated: true }
}

async function findOrCreateConversation(
  accountId: string,
  configOwnerUserId: string,
  contactId: string,
) {
  // Look for an existing conversation in this account, oldest-first.
  //
  // We deliberately do NOT use `.single()` here. `.single()` errors on
  // *both* 0 rows and ≥2 rows. Ordering oldest-first and taking one row
  // makes the lookup resolve to the same canonical survivor the dedup
  // migration (036) keeps, so pre-existing duplicates converge instead
  // of compounding.
  const { data: existingRows, error: findError } = await supabaseAdmin()
    .from('conversations')
    .select('*')
    .eq('account_id', accountId)
    .eq('contact_id', contactId)
    .order('created_at', { ascending: true })
    .limit(1)

  if (findError) {
    console.error('Error finding conversation:', findError)
    return null
  }

  if (existingRows && existingRows.length > 0) {
    return { conversation: existingRows[0], created: false }
  }

  // Create new conversation.
  const { data: newConv, error: createError } = await supabaseAdmin()
    .from('conversations')
    .insert({
      account_id: accountId,
      user_id: configOwnerUserId,
      contact_id: contactId,
    })
    .select()
    .single()

  if (createError) {
    // Lost a race: a concurrent inbound delivery created the
    // conversation between our lookup and insert. Re-resolve the
    // winning row instead of dropping the message.
    if (isUniqueViolation(createError)) {
      const { data: raced } = await supabaseAdmin()
        .from('conversations')
        .select('*')
        .eq('account_id', accountId)
        .eq('contact_id', contactId)
        .order('created_at', { ascending: true })
        .limit(1)
      if (raced && raced.length > 0) {
        return { conversation: raced[0], created: false }
      }
    }
    console.error('Error creating conversation:', createError)
    return null
  }

  return { conversation: newConv, created: true }
}
