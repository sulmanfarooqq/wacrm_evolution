-- ============================================================
-- 037_evolution_provider.sql
--
-- Moves the WhatsApp integration from the official Meta Cloud API
-- to a self-hosted Evolution API instance.
--
--   whatsapp_config gains:
--     provider              'meta' (legacy) | 'evolution' (default going forward)
--     instance_name         Evolution instance name (e.g. "evolution_exchange")
--     api_base_url          Evolution server URL (e.g. https://host/), fallback
--                           to EVOLUTION_API_URL when null
--     webhook_configured_at timestamp of the last successful Evolution
--                           webhook.set call (the "is it actually live?"
--                           signal, replacing Meta's /register semantics)
--
--   phone_number_id is reused as the Evolution instance name (it's a
--   plain text column and its UNIQUE constraint now means "one account
--   per instance"). access_token continues to hold the AES-256-GCM
--   encrypted Evolution API key.
--
--   ai_configs.provider gains 'gemini' so the AI assistant can use
--   Google's Gemini models (the default going forward).
--
-- Idempotent — safe to re-run.
-- ============================================================

ALTER TABLE whatsapp_config
  ADD COLUMN IF NOT EXISTS provider TEXT NOT NULL DEFAULT 'meta',
  ADD COLUMN IF NOT EXISTS instance_name TEXT,
  ADD COLUMN IF NOT EXISTS api_base_url TEXT,
  ADD COLUMN IF NOT EXISTS webhook_configured_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_whatsapp_config_instance_name
  ON whatsapp_config (instance_name)
  WHERE instance_name IS NOT NULL;

-- Rebuild the ai_configs provider CHECK to allow Gemini.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname IN ('ai_configs_provider_check', 'ai_configs_provider_key')
  ) THEN
    ALTER TABLE ai_configs DROP CONSTRAINT ai_configs_provider_check;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'ai_configs_provider_check'
      AND conrelid = 'ai_configs'::regclass
  ) THEN
    ALTER TABLE ai_configs
      ADD CONSTRAINT ai_configs_provider_check
      CHECK (provider IN ('openai', 'anthropic', 'gemini'));
  END IF;
END $$;
