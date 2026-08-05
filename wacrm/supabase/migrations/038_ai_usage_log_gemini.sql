-- ============================================================
-- 038_ai_usage_log_gemini.sql
--
-- 037 opened ai_configs.provider to 'gemini' but forgot the
-- ai_usage_log provider CHECK (created in 033), which still only
-- accepts 'openai' / 'anthropic'. Every auto-reply + draft usage
-- insert was failing with:
--
--   violates check constraint "ai_usage_log_provider_check"
--   code: 23514
--
-- logAiUsage swallows the error so replies kept flowing, but the
-- per-run token spend was never recorded. This rebuilds the CHECK
-- to include 'gemini'.
--
-- Idempotent — safe to re-run.
-- ============================================================

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'ai_usage_log_provider_check'
      AND conrelid = 'ai_usage_log'::regclass
  ) THEN
    ALTER TABLE ai_usage_log DROP CONSTRAINT ai_usage_log_provider_check;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'ai_usage_log_provider_check'
      AND conrelid = 'ai_usage_log'::regclass
  ) THEN
    ALTER TABLE ai_usage_log
      ADD CONSTRAINT ai_usage_log_provider_check
      CHECK (provider IN ('openai', 'anthropic', 'gemini'));
  END IF;
END $$;
