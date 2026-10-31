BEGIN;

-- Which text model runs a person's agent is that person's choice, not a deployment
-- constant. Before this table the only source was HUSSH_GEMINI_TEXT_MODEL, read once at
-- import, so changing the model meant a redeploy and every person on a lane shared one
-- answer. The lane default stays in the environment as the last fallback; this row, when
-- present, wins for that person.
--
-- The value is a model identifier, never user information: no consent scope governs it
-- and it carries nothing to encrypt. It is validated against the server-side catalog
-- (hushh_mcp/runtime_providers/model_catalog.py) on write, so a stale or removed
-- generation can never reach a provider call.
CREATE TABLE IF NOT EXISTS one_model_preferences (
  user_id TEXT PRIMARY KEY REFERENCES actor_profiles(user_id) ON DELETE CASCADE,
  text_model TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE one_model_preferences IS
  'Per-person choice of the text model that runs their agent. Absent row means the lane default. Model identifier only; never user information.';

COMMENT ON COLUMN one_model_preferences.text_model IS
  'Model identifier validated against the server-side selectable catalog at write time.';

COMMIT;
