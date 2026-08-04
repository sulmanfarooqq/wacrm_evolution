import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createClient as createAdminClient } from '@supabase/supabase-js'
import {
  verifyPhoneNumber,
  setEvolutionWebhook,
} from '@/lib/whatsapp/meta-api'
import { encrypt, decrypt } from '@/lib/whatsapp/encryption'

/**
 * Resolve the caller's account_id from their profile. Inlined here
 * (rather than going through `@/lib/auth/account.getCurrentAccount`)
 * because the GET handler wants to return shaped 200s for every
 * non-auth failure mode, not throw — keeping the helper minimal lets
 * the existing response branches stay as-is.
 *
 * Returns null if the user has no profile or no account; callers
 * should treat that the same as "not connected".
 */
async function resolveAccountId(
  supabase: Awaited<ReturnType<typeof createClient>>,
  userId: string,
): Promise<string | null> {
  const { data, error } = await supabase
    .from('profiles')
    .select('account_id')
    .eq('user_id', userId)
    .maybeSingle()
  if (error || !data?.account_id) return null
  return data.account_id as string
}

// Lazy-initialised service-role client. We need it to detect an
// instance name already claimed by a *different* user — under RLS,
// the user's own session can't see other users' rows, so the conflict
// would be invisible without the service role.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _adminClient: any = null
function supabaseAdmin() {
  if (!_adminClient) {
    _adminClient = createAdminClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!
    )
  }
  return _adminClient
}

/**
 * Derive this app's public base URL (used as the Evolution webhook
 * target) from NEXT_PUBLIC_SITE_URL or the request's forwarded headers.
 */
function getAppBaseUrl(request: Request): string {
  const explicit = process.env.NEXT_PUBLIC_SITE_URL?.trim()
  if (explicit) return explicit.replace(/\/+$/, '')
  const forwardedHost = request.headers
    .get('x-forwarded-host')
    ?.split(',')[0]
    ?.trim()
  const forwardedProto = request.headers
    .get('x-forwarded-proto')
    ?.split(',')[0]
    ?.trim()
  if (forwardedHost) return `${forwardedProto || 'https'}://${forwardedHost}`
  const host = request.headers.get('host')?.trim()
  if (host) return `${new URL(request.url).protocol.replace(':', '')}://${host}`
  return ''
}

/**
 * GET /api/whatsapp/config
 *
 * Used by the "Test API Connection" button and by the page to check
 * whether the saved config is healthy. Returns 200 in all non-auth cases
 * so the UI can render an appropriate message rather than show a 500.
 *
 * Response shape:
 *   { connected: true,  phone_info: {...} }
 *   { connected: false, reason: 'no_config',        message: '...' }
 *   { connected: false, reason: 'token_corrupted',  message: '...', needs_reset: true }
 *   { connected: false, reason: 'evolution_error',  message: '...' }
 */
export async function GET() {
  try {
    const supabase = await createClient()

    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser()

    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const accountId = await resolveAccountId(supabase, user.id)
    if (!accountId) {
      return NextResponse.json(
        {
          connected: false,
          reason: 'no_account',
          message: 'Your profile is not linked to an account.',
        },
        { status: 200 },
      )
    }

    const { data: config, error: configError } = await supabase
      .from('whatsapp_config')
      .select('phone_number_id, instance_name, access_token, api_base_url, status')
      .eq('account_id', accountId)
      .maybeSingle()

    if (configError) {
      console.error('Error fetching whatsapp_config:', configError)
      return NextResponse.json(
        { connected: false, reason: 'db_error', message: 'Failed to fetch configuration' },
        { status: 200 }
      )
    }

    if (!config) {
      return NextResponse.json(
        {
          connected: false,
          reason: 'no_config',
          message: 'No WhatsApp configuration saved yet. Fill in the form and click Save Configuration.',
        },
        { status: 200 }
      )
    }

    // Try to decrypt the stored API key with the current ENCRYPTION_KEY.
    // If this fails, the key changed (or was never consistent across envs).
    let accessToken: string
    try {
      accessToken = decrypt(config.access_token)
    } catch (err) {
      console.error('[whatsapp/config GET] Token decryption failed:', err)
      return NextResponse.json(
        {
          connected: false,
          reason: 'token_corrupted',
          needs_reset: true,
          message:
            'The stored API key cannot be decrypted with the current ENCRYPTION_KEY. This usually means the key changed, or it differs between environments (local vs Hostinger vs Vercel). Click "Reset Configuration" below, then re-save.',
        },
        { status: 200 }
      )
    }

    // Validate credentials against the Evolution instance
    try {
      const phoneInfo = await verifyPhoneNumber({
        phoneNumberId: config.phone_number_id,
        accessToken,
        apiBaseUrl: config.api_base_url ?? undefined,
      })
      return NextResponse.json({ connected: true, phone_info: phoneInfo })
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown Evolution API error'
      console.error('[whatsapp/config GET] Evolution API verification failed:', message)
      return NextResponse.json(
        {
          connected: false,
          reason: 'evolution_error',
          message: `Evolution API rejected the credentials: ${message}`,
        },
        { status: 200 }
      )
    }
  } catch (error) {
    console.error('Error in WhatsApp config GET:', error)
    return NextResponse.json(
      { connected: false, reason: 'unknown', message: 'Internal server error' },
      { status: 500 }
    )
  }
}

/**
 * POST /api/whatsapp/config
 *
 * Saves or updates the Evolution config for the authenticated user.
 * Verifies the instance + API key first, then configures the webhook
 * and persists the encrypted key.
 *
 * Body: { instance_name, access_token, api_base_url? }
 * (`phone_number_id` is accepted as an alias for `instance_name`.)
 */
export async function POST(request: Request) {
  try {
    const supabase = await createClient()

    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser()

    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const accountId = await resolveAccountId(supabase, user.id)
    if (!accountId) {
      return NextResponse.json(
        { error: 'Your profile is not linked to an account.' },
        { status: 403 },
      )
    }

    const body = await request.json()
    const instanceName = body.instance_name || body.phone_number_id || null
    const apiBaseUrl = body.api_base_url?.trim() || null
    const accessToken = body.access_token || null
    const verifyToken = body.verify_token || null

    if (!accessToken || !instanceName) {
      return NextResponse.json(
        { error: 'instance_name (Evolution instance) and access_token are required' },
        { status: 400 }
      )
    }

    // Reject if another account has already claimed this instance.
    // wacrm is single-tenant-per-WhatsApp-number — letting two accounts
    // bind the same instance makes the webhook's instance lookup
    // ambiguous and silently drops inbound messages.
    const { data: claimed, error: claimedError } = await supabaseAdmin()
      .from('whatsapp_config')
      .select('account_id')
      .eq('phone_number_id', instanceName)
      .neq('account_id', accountId)
      .maybeSingle()

    if (claimedError) {
      console.error('Error checking instance ownership:', claimedError)
      return NextResponse.json(
        { error: 'Failed to validate configuration' },
        { status: 500 }
      )
    }

    if (claimed) {
      return NextResponse.json(
        {
          error:
            'This Evolution instance is already linked to another account on this instance. Each WhatsApp number can only be connected to one wacrm user.',
        },
        { status: 409 }
      )
    }

    // Verify the instance + API key BEFORE saving.
    let phoneInfo
    try {
      phoneInfo = await verifyPhoneNumber({
        phoneNumberId: instanceName,
        accessToken,
        apiBaseUrl: apiBaseUrl ?? undefined,
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown Evolution API error'
      console.error('Evolution API verification failed during save:', message)
      return NextResponse.json(
        { error: `Evolution API error: ${message}` },
        { status: 400 }
      )
    }

    // Encrypt sensitive tokens before storing.
    let encryptedAccessToken: string
    let encryptedVerifyToken: string | null
    try {
      encryptedAccessToken = encrypt(accessToken)
      encryptedVerifyToken = verifyToken ? encrypt(verifyToken) : null
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown encryption error'
      console.error('Encryption failed:', message)
      return NextResponse.json(
        {
          error:
            'Failed to encrypt token. Check that ENCRYPTION_KEY is a valid 64-character hex string in your environment variables.',
        },
        { status: 500 }
      )
    }

    // Configure the instance's webhook so inbound events reach this app.
    // Best-effort: a failed webhook set should not block saving the
    // credentials (the UI surfaces webhook_configured_at separately),
    // but the app can't receive inbound messages until it succeeds.
    const appBaseUrl = getAppBaseUrl(request)
    let webhookConfiguredAt: string | null = null
    let webhookError: string | null = null
    if (appBaseUrl) {
      try {
        await setEvolutionWebhook({
          instanceName,
          apiKey: accessToken,
          apiBaseUrl: apiBaseUrl ?? undefined,
          url: `${appBaseUrl}/api/whatsapp/webhook`,
        })
        webhookConfiguredAt = new Date().toISOString()
      } catch (err) {
        webhookError = err instanceof Error ? err.message : String(err)
        console.error('[whatsapp/config] webhook.set failed:', webhookError)
      }
    } else {
      webhookError =
        'Could not determine this app\'s public URL — webhook not configured. Set NEXT_PUBLIC_SITE_URL.'
    }

    // Look up any pre-existing row so we can update in place.
    const { data: existing } = await supabase
      .from('whatsapp_config')
      .select('id')
      .eq('account_id', accountId)
      .maybeSingle()

    const baseRow = {
      phone_number_id: instanceName,
      instance_name: instanceName,
      api_base_url: apiBaseUrl,
      provider: 'evolution',
      waba_id: null,
      access_token: encryptedAccessToken,
      verify_token: encryptedVerifyToken,
      status: webhookError ? 'disconnected' : 'connected',
      connected_at: webhookError ? null : new Date().toISOString(),
      webhook_configured_at: webhookConfiguredAt,
      last_registration_error: webhookError,
      updated_at: new Date().toISOString(),
    }

    if (existing) {
      const { error: updateError } = await supabase
        .from('whatsapp_config')
        .update(baseRow)
        .eq('account_id', accountId)

      if (updateError) {
        console.error('Error updating whatsapp_config:', updateError)
        return NextResponse.json(
          { error: 'Failed to update configuration' },
          { status: 500 }
        )
      }
    } else {
      const { error: insertError } = await supabase
        .from('whatsapp_config')
        .insert({
          account_id: accountId,
          user_id: user.id,
          ...baseRow,
        })

      if (insertError) {
        console.error('Error inserting whatsapp_config:', insertError)
        return NextResponse.json(
          { error: 'Failed to save configuration' },
          { status: 500 }
        )
      }
    }

    if (webhookError) {
      // Save succeeded but the number isn't actually live. Return
      // 200 with a structured error so the UI can show the specific
      // remediation step instead of a generic toast.
      return NextResponse.json({
        success: false,
        saved: true,
        webhook_configured: false,
        webhook_error: webhookError,
        phone_info: phoneInfo,
      })
    }

    return NextResponse.json({
      success: true,
      saved: true,
      webhook_configured: true,
      phone_info: phoneInfo,
    })
  } catch (error) {
    console.error('Error in WhatsApp config POST:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

/**
 * DELETE /api/whatsapp/config
 *
 * Removes the authenticated user's WhatsApp configuration row.
 * Used by the "Reset Configuration" button to recover from a corrupted
 * encrypted token (mismatched ENCRYPTION_KEY across environments).
 */
export async function DELETE() {
  try {
    const supabase = await createClient()

    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser()

    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const accountId = await resolveAccountId(supabase, user.id)
    if (!accountId) {
      return NextResponse.json(
        { error: 'Your profile is not linked to an account.' },
        { status: 403 },
      )
    }

    const { error: deleteError } = await supabase
      .from('whatsapp_config')
      .delete()
      .eq('account_id', accountId)

    if (deleteError) {
      console.error('Error deleting whatsapp_config:', deleteError)
      return NextResponse.json(
        { error: 'Failed to delete configuration' },
        { status: 500 }
      )
    }

    return NextResponse.json({ success: true })
  } catch (error) {
    console.error('Error in WhatsApp config DELETE:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
