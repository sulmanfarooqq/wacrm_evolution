import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { decrypt } from '@/lib/whatsapp/encryption'
import { verifyPhoneNumber } from '@/lib/whatsapp/meta-api'

/**
 * GET /api/whatsapp/config/verify-registration
 *
 * Diagnostic endpoint — confirms the user's saved Evolution instance is
 * actually reachable and that the webhook has been configured so
 * inbound events can reach this app.
 *
 * Checks:
 *   1. phone_metadata_ok — GET /instance/connectionState/{instance}
 *                    succeeds and the instance state is "open"
 *   2. webhook_configured — local timestamp written by POST /config
 *                    when the last webhook.set call succeeded
 *   3. locally_marked_registered — kept for shape parity; true when the
 *                    row was saved as connected
 *
 * Returns 200 in every case so the UI can render diagnostic detail
 * rather than a generic error toast. The combined `live` flag is what
 * the UI badges on.
 */
export async function GET() {
  const supabase = await createClient()
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser()
  if (authError || !user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  // whatsapp_config is one-row-per-account post-017. Resolve the
  // caller's account_id so a teammate who joined an existing account
  // sees the same registration state as the admin who set it up.
  const { data: profile } = await supabase
    .from('profiles')
    .select('account_id')
    .eq('user_id', user.id)
    .maybeSingle()
  const accountId = profile?.account_id as string | undefined
  if (!accountId) {
    return NextResponse.json({
      live: false,
      checks: { config_exists: false },
      message: 'Your profile is not linked to an account.',
    })
  }

  const { data: config } = await supabase
    .from('whatsapp_config')
    .select('*')
    .eq('account_id', accountId)
    .maybeSingle()

  if (!config) {
    return NextResponse.json({
      live: false,
      checks: { config_exists: false },
      message: 'No WhatsApp configuration saved yet.',
    })
  }

  let accessToken: string
  try {
    accessToken = decrypt(config.access_token)
  } catch {
    return NextResponse.json({
      live: false,
      checks: {
        config_exists: true,
        token_decryptable: false,
      },
      message:
        'Stored API key can\'t be decrypted — likely ENCRYPTION_KEY changed. Re-enter the key to repair.',
    })
  }

  const checks: {
    config_exists: boolean
    token_decryptable: boolean
    phone_metadata_ok: boolean
    webhook_configured: boolean
    locally_marked_registered: boolean
  } = {
    config_exists: true,
    token_decryptable: true,
    phone_metadata_ok: false,
    webhook_configured: config.webhook_configured_at != null,
    locally_marked_registered: config.connected_at != null,
  }
  const errors: string[] = []

  // 1. Instance connection state — validates the API key + instance
  try {
    await verifyPhoneNumber({
      phoneNumberId: config.phone_number_id,
      accessToken,
      apiBaseUrl: config.api_base_url ?? undefined,
    })
    checks.phone_metadata_ok = true
  } catch (err) {
    errors.push(
      `Instance connection check failed: ${err instanceof Error ? err.message : String(err)}`,
    )
  }

  // 2. Webhook wiring — no webhook means no inbound messages, no matter
  // how healthy the instance is.
  if (!checks.webhook_configured) {
    errors.push(
      'Webhook not configured. Re-save the configuration (with a reachable public URL) so Evolution can deliver inbound events.',
    )
  }

  const live =
    checks.phone_metadata_ok &&
    checks.webhook_configured &&
    checks.locally_marked_registered

  return NextResponse.json({
    live,
    checks,
    errors,
    last_registration_error: config.last_registration_error ?? null,
    webhook_configured_at: config.webhook_configured_at ?? null,
    connected_at: config.connected_at ?? null,
  })
}
