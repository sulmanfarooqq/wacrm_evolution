/**
 * WhatsApp client for the self-hosted Evolution API.
 *
 * This replaced the Meta WhatsApp Cloud API client (migration 037).
 * Every function keeps the same exported name + options-object shape
 * so callers only need to thread through `apiBaseUrl` when they have
 * a per-account base URL (stored in `whatsapp_config.api_base_url`).
 *
 * Mapping from the old Meta client to Evolution:
 *   * `phoneNumberId`  → the Evolution **instance name** (reused column)
 *   * `accessToken`    → the Evolution **API key** (sent as `apikey` header)
 *   * `wabaId`         → unused — Evolution has no WABA concept
 *
 * Evolution has no template approval flow, no Resumable Upload and no
 * WABA subscription, so the functions that backed those features are
 * now local no-ops / local-success stubs. Outbound "template" sends
 * become free-form text resolved from the local template row.
 */

import type { MessageTemplate } from '@/types'
import type { SendTimeParams } from './template-send-builder'
import type { MetaTemplateSubmitPayload } from './template-components'

const DEFAULT_EVOLUTION_BASE_URL =
  process.env.EVOLUTION_API_URL ??
  'https://evolution-api-production-3988.up.railway.app'

export interface MetaSendResult {
  messageId: string
}

export interface MetaPhoneInfo {
  id: string
  display_phone_number: string
  verified_name?: string
  quality_rating?: string
}

// ============================================================
// Transport
// ============================================================

interface EvolutionRequestOptions {
  apiBaseUrl?: string
  apiKey: string
  instanceName: string
  method?: 'GET' | 'POST'
  path: string
  body?: unknown
}

async function evolutionRequest(
  options: EvolutionRequestOptions
): Promise<Record<string, unknown>> {
  const { apiBaseUrl, apiKey, instanceName, method = 'POST', path, body } = options
  const base = (apiBaseUrl || DEFAULT_EVOLUTION_BASE_URL).replace(/\/+$/, '')
  const url = `${base}/${path.replace('{instance}', instanceName)}`

  const response = await fetch(url, {
    method,
    headers: {
      'Content-Type': 'application/json',
      apikey: apiKey,
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
  if (!response.ok) {
    await throwEvolutionError(response, `Evolution API error: ${response.status}`)
  }
  return response.json().catch(() => ({}))
}

/** Pull a human-readable message out of Evolution's error envelopes. */
async function throwEvolutionError(
  response: Response,
  fallback: string
): Promise<never> {
  let message = fallback
  try {
    const data = (await response.json()) as {
      message?: unknown
      error?: unknown
      response?: unknown
    }
    if (typeof data.message === 'string') message = data.message
    else if (typeof data.error === 'string') message = data.error
    else if (
      data.error &&
      typeof data.error === 'object' &&
      typeof (data.error as { message?: unknown }).message === 'string'
    ) {
      message = (data.error as { message: string }).message
    } else if (typeof data.response === 'string') message = data.response
  } catch {
    // response body wasn't JSON — keep the fallback
  }
  throw new Error(message)
}

/** The message id Evolution returns for a send lives at `key.id`. */
function extractMessageId(parsed: Record<string, unknown>): string {
  const key = (parsed as { key?: { id?: string } }).key
  if (key?.id) return key.id
  const data = (parsed as { data?: { key?: { id?: string } } }).data
  if (data?.key?.id) return data.key.id
  return ''
}

// ============================================================
// Instance / connection
// ============================================================

export interface EvolutionConnectionStateArgs {
  instanceName: string
  apiKey: string
  apiBaseUrl?: string
}

export interface EvolutionConnectionState {
  state: string
  ownerJid?: string
}

/**
 * GET /instance/connectionState/{instance}
 *
 * Resolves the instance's current WhatsApp connection state. The
 * webhook / connection-test paths use this to decide whether the
 * number is actually live.
 */
export async function getEvolutionConnectionState(
  args: EvolutionConnectionStateArgs
): Promise<EvolutionConnectionState> {
  const { instanceName, apiKey, apiBaseUrl } = args
  const parsed = await evolutionRequest({
    method: 'GET',
    instanceName,
    apiKey,
    apiBaseUrl,
    path: 'instance/connectionState/{instance}',
  })
  const instance = (parsed as { instance?: Record<string, unknown> }).instance
  if (!instance || typeof instance !== 'object') {
    throw new Error('Evolution returned no instance data for the connection state.')
  }
  return {
    state: typeof instance.state === 'string' ? instance.state : 'unknown',
    ownerJid:
      typeof instance.ownerJid === 'string' ? instance.ownerJid : undefined,
  }
}

export interface SetEvolutionWebhookArgs {
  instanceName: string
  apiKey: string
  apiBaseUrl?: string
  /** The publicly reachable URL Evolution should POST events to. */
  url: string
  /**
   * Event names to enable. Defaults to the three wacrm listens to:
   * MESSAGES_UPSERT, MESSAGES_UPDATE, CONNECTION_UPDATE.
   */
  events?: string[]
}

/**
 * POST /webhook/set/{instance}
 *
 * Configure the instance's webhook. Evolution authenticates inbound
 * deliveries by the instance's `apikey` (embedded in the event body),
 * so no separate verify-token dance is needed.
 *
 * `base64: false` keeps the payload light — inbound media is downloaded
 * on demand via getBase64FromMediaMessage instead of being base64-embedded
 * in every event.
 *
 * Body shape is the v2 `webhook` wrapper object ({ enabled, url,
 * byEvents, base64, events }). The v1 flat snake_case form
 * ({ url, webhook_by_events, ... }) is rejected with 400.
 */
export async function setEvolutionWebhook(
  args: SetEvolutionWebhookArgs
): Promise<void> {
  const {
    instanceName,
    apiKey,
    apiBaseUrl,
    url,
    events = ['MESSAGES_UPSERT', 'MESSAGES_UPDATE', 'CONNECTION_UPDATE'],
  } = args
  await evolutionRequest({
    instanceName,
    apiKey,
    apiBaseUrl,
    path: 'webhook/set/{instance}',
    body: {
      webhook: {
        enabled: true,
        url,
        byEvents: false,
        base64: false,
        events,
      },
    },
  })
}

// ============================================================
// Phone number / account
// ============================================================

export interface VerifyPhoneNumberArgs {
  phoneNumberId: string
  accessToken: string
  apiBaseUrl?: string
}

/**
 * Verify the instance + API key by fetching its connection state.
 * Throws (with the instance state in the message) when the instance
 * exists but the number isn't connected.
 */
export async function verifyPhoneNumber(
  args: VerifyPhoneNumberArgs
): Promise<MetaPhoneInfo> {
  const { phoneNumberId, accessToken, apiBaseUrl } = args
  const state = await getEvolutionConnectionState({
    instanceName: phoneNumberId,
    apiKey: accessToken,
    apiBaseUrl,
  })
  if (state.state !== 'open') {
    throw new Error(
      `Evolution instance "${phoneNumberId}" is not connected (state: ${state.state}). Open the Evolution Manager and reconnect the number.`
    )
  }
  const ownerJid = state.ownerJid ?? phoneNumberId
  const ownerNumber = ownerJid.replace(/@s\.whatsapp\.net$/, '')
  return {
    id: phoneNumberId,
    display_phone_number: ownerNumber,
    verified_name: ownerNumber,
    quality_rating: state.state,
  }
}

export interface RegisterPhoneNumberArgs {
  phoneNumberId: string
  accessToken: string
  /**
   * Kept for backward compat — Evolution has no /register or 2FA PIN
   * step. Webhook wiring happens on save via `setEvolutionWebhook`.
   */
  pin: string
  apiBaseUrl?: string
}

export interface RegisterPhoneNumberResult {
  success: boolean
  alreadyRegistered: boolean
}

/**
 * No-op for Evolution: instances are connected once and webhooks are
 * configured via `setEvolutionWebhook`. Present so the pre-migration
 * callers keep compiling.
 */
export async function registerPhoneNumber(
  args: RegisterPhoneNumberArgs
): Promise<RegisterPhoneNumberResult> {
  void args
  return { success: true, alreadyRegistered: false }
}

export interface SubscribeWabaToAppArgs {
  wabaId: string
  accessToken: string
  apiBaseUrl?: string
}

/**
 * No-op for Evolution — there is no WABA-level app subscription.
 */
export async function subscribeWabaToApp(
  args: SubscribeWabaToAppArgs
): Promise<void> {
  void args
}

export interface GetSubscribedAppsArgs {
  wabaId: string
  accessToken: string
  apiBaseUrl?: string
}

export interface SubscribedApp {
  whatsapp_business_api_data?: {
    id?: string
    name?: string
    link?: string
  }
}

/**
 * No-op for Evolution — returns an empty list. Webhook state is
 * checked via `getEvolutionConnectionState` instead.
 */
export async function getSubscribedApps(
  args: GetSubscribedAppsArgs
): Promise<SubscribedApp[]> {
  void args
  return []
}

// ============================================================
// Sending
// ============================================================

export interface SendTextMessageArgs {
  phoneNumberId: string
  accessToken: string
  to: string
  text: string
  /**
   * The message id of the message being replied to. Adds Evolution's
   * `quoted` field so WhatsApp renders the new message as a reply.
   */
  contextMessageId?: string
  apiBaseUrl?: string
}

/**
 * Send a free-form WhatsApp text message via
 * POST /message/sendText/{instance}.
 */
export async function sendTextMessage(
  args: SendTextMessageArgs
): Promise<MetaSendResult> {
  const { phoneNumberId, accessToken, to, text, contextMessageId, apiBaseUrl } = args
  const body: Record<string, unknown> = { number: to, text }
  if (contextMessageId) {
    body.quoted = { message: { conversation: { id: contextMessageId } } }
  }
  const parsed = await evolutionRequest({
    instanceName: phoneNumberId,
    apiKey: accessToken,
    apiBaseUrl,
    path: 'message/sendText/{instance}',
    body,
  })
  return { messageId: extractMessageId(parsed) }
}

export type MediaKind = 'image' | 'video' | 'document' | 'audio'

export interface SendMediaMessageArgs {
  phoneNumberId: string
  accessToken: string
  to: string
  kind: MediaKind
  /** Public URL Evolution fetches at send time. */
  link: string
  /** Optional caption — images + videos + documents accept it; audio does NOT. */
  caption?: string
  /** Document-only. Shown in the recipient's chat as the file name. */
  filename?: string
  contextMessageId?: string
  apiBaseUrl?: string
}

/**
 * Send an image, video, document, or audio (voice note) via a public
 * URL using POST /message/sendMedia/{instance}. The MIME type is
 * derived from the URL/file extension (falling back to a per-kind
 * default) since Evolution requires it.
 */
export async function sendMediaMessage(
  args: SendMediaMessageArgs
): Promise<MetaSendResult> {
  const {
    phoneNumberId,
    accessToken,
    to,
    kind,
    link,
    caption,
    filename,
    contextMessageId,
    apiBaseUrl,
  } = args
  if (!link) throw new Error('sendMediaMessage requires a link.')

  // Audio accepts neither caption nor fileName — adding either yields
  // a 400. image/video/document accept a caption; only document
  // accepts a fileName.
  const body: Record<string, unknown> = {
    number: to,
    mediatype: kind,
    mimetype: guessMimeType(kind, link, filename),
    media: link,
  }
  if (caption && kind !== 'audio') body.caption = caption
  if (kind === 'document' && filename) body.fileName = filename
  if (contextMessageId) {
    body.quoted = { message: { conversation: { id: contextMessageId } } }
  }

  const parsed = await evolutionRequest({
    instanceName: phoneNumberId,
    apiKey: accessToken,
    apiBaseUrl,
    path: 'message/sendMedia/{instance}',
    body,
  })
  return { messageId: extractMessageId(parsed) }
}

const EXT_TO_MIME: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  gif: 'image/gif',
  mp4: 'video/mp4',
  webm: 'video/webm',
  pdf: 'application/pdf',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  csv: 'text/csv',
  txt: 'text/plain',
  ogg: 'audio/ogg',
  opus: 'audio/ogg; codecs=opus',
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  wav: 'audio/wav',
}

const KIND_DEFAULT_MIME: Record<MediaKind, string> = {
  image: 'image/jpeg',
  video: 'video/mp4',
  document: 'application/octet-stream',
  audio: 'audio/ogg',
}

function guessMimeType(
  kind: MediaKind,
  link: string,
  filename?: string
): string {
  const source = (filename || link.split(/[?#]/)[0]).split('.').pop()
  const ext = source ? source.toLowerCase() : ''
  if (ext && EXT_TO_MIME[ext]) return EXT_TO_MIME[ext]
  return KIND_DEFAULT_MIME[kind]
}

export interface SendTemplateMessageArgs {
  phoneNumberId: string
  accessToken: string
  to: string
  templateName: string
  language?: string
  /**
   * Legacy body-only params. Kept for backward compat with callers
   * that haven't migrated to the structured `template` + `messageParams`
   * pair below.
   */
  params?: string[]
  /**
   * The template row from message_templates. Its `body_text` is used
   * to resolve the free-form text Evolution sends (Evolution has no
   * Meta template system).
   */
  template?: MessageTemplate
  /**
   * Structured per-send values. Body variables go in `body` — they
   * substitute the {{N}} placeholders in `template.body_text`.
   */
  messageParams?: SendTimeParams
  /** The message id of the message being replied to. */
  contextMessageId?: string
  apiBaseUrl?: string
}

/**
 * Send a "template" as free-form text via Evolution.
 *
 * Evolution has no template approval / submission flow, so a template
 * send is just a text message whose body is resolved from the local
 * template row ({{N}} placeholders substituted with the send params).
 * Without a row, the params are joined, and with neither the template
 * name is used verbatim as a last resort.
 */
export async function sendTemplateMessage(
  args: SendTemplateMessageArgs
): Promise<MetaSendResult> {
  const {
    phoneNumberId,
    accessToken,
    to,
    templateName,
    template,
    messageParams,
    params,
    contextMessageId,
    apiBaseUrl,
  } = args

  const bodyValues =
    messageParams?.body && messageParams.body.length > 0
      ? messageParams.body
      : (params ?? [])

  let text = template?.body_text ?? ''
  if (text) {
    text = text.replace(/\{\{(\d+)\}\}/g, (_, n: string) => {
      const value = bodyValues[Number(n) - 1]
      return value === undefined || value === null ? '' : String(value)
    })
  } else if (bodyValues.length > 0) {
    text = bodyValues.join(' ')
  } else {
    text = templateName
  }

  return sendTextMessage({
    phoneNumberId,
    accessToken,
    to,
    text,
    contextMessageId,
    apiBaseUrl,
  })
}

// ============================================================
// Template management (local-only with Evolution)
// ============================================================
//
// Meta's template approval flow (submit / edit / delete / Resumable
// Upload handles) has no Evolution equivalent. These functions exist
// so the pre-migration template routes keep compiling; they operate
// purely locally and never touch the network.

export interface UploadResumableMediaArgs {
  appId: string
  accessToken: string
  fileName: string
  mimeType: string
  bytes: Uint8Array
}

/**
 * Meta-only feature. Evolution stores media by URL and has no
 * Resumable Upload — templates with an image header can't create a
 * handle, so this throws a clear error instead of silently doing the
 * wrong thing.
 */
export async function uploadResumableMedia(
  args: UploadResumableMediaArgs
): Promise<{ handle: string }> {
  void args
  throw new Error(
    'Evolution API has no Resumable Upload — template media handles are a Meta-only concept. Remove the image header to create the template locally.'
  )
}

export interface SubmitMessageTemplateArgs {
  wabaId: string
  accessToken: string
  payload: MetaTemplateSubmitPayload
}

export interface SubmitMessageTemplateResult {
  id: string
  status: string
  category?: string
}

/**
 * Local-only stub: Evolution has no approval flow, so templates are
 * immediately usable. Returns a synthetic id so callers can persist a
 * `meta_template_id` without a Meta round-trip.
 */
export async function submitMessageTemplate(
  args: SubmitMessageTemplateArgs
): Promise<SubmitMessageTemplateResult> {
  const { payload } = args
  return {
    id: `local-${crypto.randomUUID()}`,
    status: 'APPROVED',
    category: typeof payload.category === 'string' ? payload.category : undefined,
  }
}

export interface EditMessageTemplateArgs {
  metaTemplateId: string
  accessToken: string
  components: MetaTemplateSubmitPayload['components']
  category?: MetaTemplateSubmitPayload['category']
}

export interface EditMessageTemplateResult {
  success: boolean
}

/**
 * Local-only stub — nothing to edit on Evolution's side.
 */
export async function editMessageTemplate(
  args: EditMessageTemplateArgs
): Promise<EditMessageTemplateResult> {
  void args
  return { success: true }
}

export interface DeleteMessageTemplateArgs {
  wabaId: string
  accessToken: string
  name: string
  metaTemplateId?: string
}

/**
 * Local-only stub — nothing to delete on Evolution's side.
 */
export async function deleteMessageTemplate(
  args: DeleteMessageTemplateArgs
): Promise<void> {
  void args
}

// ============================================================
// Reactions
// ============================================================

export interface SendReactionMessageArgs {
  phoneNumberId: string
  accessToken: string
  to: string
  /** The message id of the message being reacted to. */
  targetMessageId: string
  /** Single emoji, or empty string to remove an existing reaction. */
  emoji: string
  apiBaseUrl?: string
}

/**
 * Send a reaction (or removal) to a previously-exchanged message via
 * POST /message/sendReaction/{instance}. Empty `emoji` removes it.
 */
export async function sendReactionMessage(
  args: SendReactionMessageArgs
): Promise<MetaSendResult> {
  const {
    phoneNumberId,
    accessToken,
    to,
    targetMessageId,
    emoji,
    apiBaseUrl,
  } = args
  await evolutionRequest({
    instanceName: phoneNumberId,
    apiKey: accessToken,
    apiBaseUrl,
    path: 'message/sendReaction/{instance}',
    body: {
      key: {
        remoteJid: `${to}@s.whatsapp.net`,
        fromMe: false,
        id: targetMessageId,
      },
      reaction: emoji,
    },
  })
  // Evolution's reaction endpoint returns an acknowledgement, not a
  // message key — there is no new message to track.
  return { messageId: '' }
}

// ============================================================
// Interactive (button replies + list messages)
// ============================================================
//
// Evolution's two flavours of interactive message — used by the Flows
// engine to drive scripted chatbot menus. Caller passes plain JS
// values; helpers shape the Evolution payload and enforce WhatsApp's
// limits BEFORE the network call so the failure mode is a
// developer-facing error rather than a customer-facing one.

/**
 * WhatsApp limits for interactive messages, hard-coded so violations
 * fail at build/save time rather than as a 400 from the API
 * mid-conversation.
 */
export const INTERACTIVE_LIMITS = {
  maxButtons: 3,
  buttonTitleMaxLength: 20,
  maxListSections: 10,
  maxListRowsTotal: 10,
  listRowTitleMaxLength: 24,
  listRowDescriptionMaxLength: 72,
  bodyMaxLength: 1024,
  footerMaxLength: 60,
  headerTextMaxLength: 60,
} as const

export interface InteractiveButton {
  /** Stable id sent back in the webhook when tapped (≤ 256 chars). */
  id: string
  /** Visible label (≤ 20 chars). */
  title: string
}

export interface SendInteractiveButtonsArgs {
  phoneNumberId: string
  accessToken: string
  to: string
  /** The body text — what the customer reads above the buttons. */
  bodyText: string
  /** Optional plain-text header (≤ 60 chars). */
  headerText?: string
  /** Optional grey footer line under the buttons (≤ 60 chars). */
  footerText?: string
  /** 1–3 buttons. Validated against WhatsApp's limits before sending. */
  buttons: InteractiveButton[]
  /** The message id of the message being replied to. */
  contextMessageId?: string
  apiBaseUrl?: string
}

/**
 * Send an interactive message with up to 3 inline reply buttons via
 * POST /message/sendButtons/{instance}. The customer taps one and
 * Evolution delivers a MESSAGES_UPSERT with `message.buttonsResponseMessage.selectedButtonId` set.
 */
export async function sendInteractiveButtons(
  args: SendInteractiveButtonsArgs
): Promise<MetaSendResult> {
  const {
    phoneNumberId, accessToken, to,
    bodyText, headerText, footerText, buttons, contextMessageId, apiBaseUrl,
  } = args
  validateInteractiveBody(bodyText)
  validateInteractiveHeaderFooter(headerText, footerText)
  if (buttons.length < 1 || buttons.length > INTERACTIVE_LIMITS.maxButtons) {
    throw new Error(
      `Interactive button message requires 1-${INTERACTIVE_LIMITS.maxButtons} buttons (got ${buttons.length}).`
    )
  }
  const seenButtonIds = new Set<string>()
  for (const btn of buttons) {
    if (!btn.id) throw new Error('Interactive button missing id.')
    if (seenButtonIds.has(btn.id)) {
      throw new Error(`Interactive message has duplicate button id "${btn.id}".`)
    }
    seenButtonIds.add(btn.id)
    if (!btn.title) throw new Error(`Interactive button "${btn.id}" missing title.`)
    if (btn.title.length > INTERACTIVE_LIMITS.buttonTitleMaxLength) {
      throw new Error(
        `Interactive button title "${btn.title}" exceeds ${INTERACTIVE_LIMITS.buttonTitleMaxLength} chars.`
      )
    }
  }

  const parsed = await evolutionRequest({
    instanceName: phoneNumberId,
    apiKey: accessToken,
    apiBaseUrl,
    path: 'message/sendButtons/{instance}',
    body: {
      number: to,
      title: headerText ?? '',
      description: bodyText,
      footer: footerText ?? '',
      buttons: buttons.map((b) => ({
        title: 'reply',
        displayText: b.title,
        id: b.id,
      })),
      ...(contextMessageId
        ? { quoted: { message: { conversation: { id: contextMessageId } } } }
        : {}),
    },
  })
  return { messageId: extractMessageId(parsed) }
}

export interface InteractiveListRow {
  /** Stable id sent back in the webhook when tapped (≤ 200 chars). */
  id: string
  /** Visible row title (≤ 24 chars). */
  title: string
  /** Optional secondary line shown under the title (≤ 72 chars). */
  description?: string
}

export interface InteractiveListSection {
  /** Optional section header shown above its rows. */
  title?: string
  rows: InteractiveListRow[]
}

export interface SendInteractiveListArgs {
  phoneNumberId: string
  accessToken: string
  to: string
  bodyText: string
  /** Label of the tap-to-expand button on the message bubble. */
  buttonLabel: string
  headerText?: string
  footerText?: string
  /**
   * 1–10 rows TOTAL across all sections. Validation enforces this
   * before send.
   */
  sections: InteractiveListSection[]
  contextMessageId?: string
  apiBaseUrl?: string
}

/**
 * Send an interactive message with a tap-to-expand list of selectable
 * rows via POST /message/sendList/{instance}. Webhook arrives with
 * `message.listResponseMessage.singleSelectReply.selectedRowId` set.
 */
export async function sendInteractiveList(
  args: SendInteractiveListArgs
): Promise<MetaSendResult> {
  const {
    phoneNumberId, accessToken, to,
    bodyText, buttonLabel, headerText, footerText, sections, contextMessageId, apiBaseUrl,
  } = args
  validateInteractiveBody(bodyText)
  validateInteractiveHeaderFooter(headerText, footerText)
  if (!buttonLabel) throw new Error('Interactive list requires a buttonLabel.')
  if (buttonLabel.length > INTERACTIVE_LIMITS.buttonTitleMaxLength) {
    throw new Error(
      `Interactive list buttonLabel "${buttonLabel}" exceeds ${INTERACTIVE_LIMITS.buttonTitleMaxLength} chars.`
    )
  }
  if (sections.length < 1 || sections.length > INTERACTIVE_LIMITS.maxListSections) {
    throw new Error(
      `Interactive list requires 1-${INTERACTIVE_LIMITS.maxListSections} sections (got ${sections.length}).`
    )
  }
  const totalRows = sections.reduce((sum, s) => sum + s.rows.length, 0)
  if (totalRows < 1 || totalRows > INTERACTIVE_LIMITS.maxListRowsTotal) {
    throw new Error(
      `Interactive list requires 1-${INTERACTIVE_LIMITS.maxListRowsTotal} rows total across all sections (got ${totalRows}).`
    )
  }
  const seenIds = new Set<string>()
  for (const section of sections) {
    for (const row of section.rows) {
      if (!row.id) throw new Error('Interactive list row missing id.')
      if (seenIds.has(row.id)) {
        throw new Error(`Interactive list has duplicate row id "${row.id}".`)
      }
      seenIds.add(row.id)
      if (!row.title) throw new Error(`Interactive list row "${row.id}" missing title.`)
      if (row.title.length > INTERACTIVE_LIMITS.listRowTitleMaxLength) {
        throw new Error(
          `Interactive list row title "${row.title}" exceeds ${INTERACTIVE_LIMITS.listRowTitleMaxLength} chars.`
        )
      }
      if (
        row.description &&
        row.description.length > INTERACTIVE_LIMITS.listRowDescriptionMaxLength
      ) {
        throw new Error(
          `Interactive list row description for "${row.id}" exceeds ${INTERACTIVE_LIMITS.listRowDescriptionMaxLength} chars.`
        )
      }
    }
  }

  const parsed = await evolutionRequest({
    instanceName: phoneNumberId,
    apiKey: accessToken,
    apiBaseUrl,
    path: 'message/sendList/{instance}',
    body: {
      number: to,
      title: headerText ?? '',
      description: bodyText,
      buttonText: buttonLabel,
      footerText: footerText ?? '',
      values: sections.map((s) => ({
        title: s.title ?? '',
        rows: s.rows.map((r) => ({
          title: r.title,
          description: r.description ?? '',
          rowId: r.id,
        })),
      })),
      ...(contextMessageId
        ? { quoted: { message: { conversation: { id: contextMessageId } } } }
        : {}),
    },
  })
  return { messageId: extractMessageId(parsed) }
}

function validateInteractiveBody(bodyText: string): void {
  if (!bodyText) throw new Error('Interactive message requires bodyText.')
  if (bodyText.length > INTERACTIVE_LIMITS.bodyMaxLength) {
    throw new Error(
      `Interactive bodyText exceeds ${INTERACTIVE_LIMITS.bodyMaxLength} chars.`
    )
  }
}

function validateInteractiveHeaderFooter(
  headerText: string | undefined,
  footerText: string | undefined,
): void {
  if (headerText && headerText.length > INTERACTIVE_LIMITS.headerTextMaxLength) {
    throw new Error(
      `Interactive headerText exceeds ${INTERACTIVE_LIMITS.headerTextMaxLength} chars.`
    )
  }
  if (footerText && footerText.length > INTERACTIVE_LIMITS.footerMaxLength) {
    throw new Error(
      `Interactive footerText exceeds ${INTERACTIVE_LIMITS.footerMaxLength} chars.`
    )
  }
}

// ============================================================
// Media
// ============================================================

export interface GetEvolutionMediaBase64Args {
  phoneNumberId: string
  accessToken: string
  apiBaseUrl?: string
  /** The message id of the media message. */
  messageId: string
  /** Set false for audio — avoids ffmpeg conversion errors on the instance. */
  convertToMp4?: boolean
}

export interface EvolutionMediaResult {
  base64: string
  mimetype?: string
  fileName?: string
  mediaType?: string
}

/**
 * POST /chat/getBase64FromMediaMessage/{instance}
 *
 * Fetch the raw bytes of an inbound media message as base64. The
 * webhook and the media proxy use this to pull image/video/document/
 * audio attachments from the instance on demand.
 */
export async function getEvolutionMediaBase64(
  args: GetEvolutionMediaBase64Args
): Promise<EvolutionMediaResult> {
  const {
    phoneNumberId,
    accessToken,
    apiBaseUrl,
    messageId,
    convertToMp4 = false,
  } = args
  const parsed = await evolutionRequest({
    instanceName: phoneNumberId,
    apiKey: accessToken,
    apiBaseUrl,
    path: 'chat/getBase64FromMediaMessage/{instance}',
    body: {
      message: { key: { id: messageId } },
      convertToMp4,
    },
  })
  return {
    base64: typeof parsed.base64 === 'string' ? parsed.base64 : '',
    mimetype: typeof parsed.mimetype === 'string' ? parsed.mimetype : undefined,
    fileName: typeof parsed.fileName === 'string' ? parsed.fileName : undefined,
    mediaType: typeof parsed.mediaType === 'string' ? parsed.mediaType : undefined,
  }
}
