-- Bounded, device-authorized calling state. No audio or plaintext SDP persists.
BEGIN;
CREATE TABLE IF NOT EXISTS public.direct_communication_keys (
  device_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES public.actor_profiles(user_id) ON DELETE CASCADE,
  key_id UUID NOT NULL UNIQUE,
  public_key TEXT NOT NULL CHECK (length(public_key) BETWEEN 80 AND 256),
  enrollment_proof JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (user_id,device_id) REFERENCES public.trusted_devices(user_id,device_id) ON DELETE CASCADE,
  CHECK (octet_length(enrollment_proof::TEXT) <= 4096)
);
CREATE TABLE IF NOT EXISTS public.direct_calls (
  id UUID PRIMARY KEY,
  conversation_id UUID NOT NULL REFERENCES public.conversations(id) ON DELETE CASCADE,
  caller_user_id TEXT NOT NULL REFERENCES public.actor_profiles(user_id) ON DELETE CASCADE,
  callee_user_id TEXT NOT NULL REFERENCES public.actor_profiles(user_id) ON DELETE CASCADE,
  caller_device_id TEXT NOT NULL,
  callee_device_id TEXT,
  state TEXT NOT NULL CHECK(state IN ('preparing','ringing','connecting','active','declined','cancelled','ended','expired')),
  revision INTEGER NOT NULL DEFAULT 0 CHECK(revision >= 0),
  caller_connected BOOLEAN NOT NULL DEFAULT FALSE,
  callee_connected BOOLEAN NOT NULL DEFAULT FALSE,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  offers JSONB NOT NULL,
  caller_proof JSONB NOT NULL,
  FOREIGN KEY(caller_user_id,caller_device_id) REFERENCES public.trusted_devices(user_id,device_id) ON DELETE CASCADE,
  FOREIGN KEY(callee_user_id,callee_device_id) REFERENCES public.trusted_devices(user_id,device_id) ON DELETE CASCADE,
  CHECK (caller_user_id <> callee_user_id),
  CHECK (octet_length(offers::TEXT) <= 600000),
  CHECK (octet_length(caller_proof::TEXT) <= 650000)
);
CREATE INDEX IF NOT EXISTS idx_direct_calls_expiry ON public.direct_calls(expires_at);
CREATE INDEX IF NOT EXISTS idx_direct_calls_callee ON public.direct_calls(callee_user_id,created_at DESC);
CREATE TABLE IF NOT EXISTS public.direct_call_slots (
  user_id TEXT PRIMARY KEY REFERENCES public.actor_profiles(user_id) ON DELETE CASCADE,
  call_id UUID NOT NULL REFERENCES public.direct_calls(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_direct_call_slots_call ON public.direct_call_slots(call_id);
CREATE TABLE IF NOT EXISTS public.direct_call_commands (
  nonce UUID PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES public.actor_profiles(user_id) ON DELETE CASCADE,
  device_id TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  FOREIGN KEY(user_id,device_id) REFERENCES public.trusted_devices(user_id,device_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_direct_call_commands_expiry ON public.direct_call_commands(expires_at);
CREATE TABLE IF NOT EXISTS public.direct_call_signals (
  sequence BIGSERIAL PRIMARY KEY,
  call_id UUID NOT NULL REFERENCES public.direct_calls(id) ON DELETE CASCADE,
  sender_device_id TEXT NOT NULL REFERENCES public.trusted_devices(device_id) ON DELETE CASCADE,
  sender_sequence INTEGER NOT NULL CHECK(sender_sequence BETWEEN 1 AND 100),
  envelope JSONB NOT NULL CHECK(octet_length(envelope::TEXT) <= 100000),
  proof JSONB NOT NULL CHECK(octet_length(proof::TEXT) <= 110000),
  UNIQUE(call_id,sender_device_id,sender_sequence)
);
CREATE INDEX IF NOT EXISTS idx_direct_call_signals_call ON public.direct_call_signals(call_id,sequence);
-- Application service is the authority; no browser/anonymous direct table access.
ALTER TABLE public.direct_communication_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.direct_calls ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.direct_call_slots ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.direct_call_commands ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.direct_call_signals ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.direct_communication_keys, public.direct_calls, public.direct_call_slots,
  public.direct_call_commands, public.direct_call_signals FROM PUBLIC;
DO $$ BEGIN
  IF to_regprocedure('public.install_account_deletion_write_guards()') IS NOT NULL THEN
    PERFORM public.install_account_deletion_write_guards();
  END IF;
END $$;
DO $$ DECLARE role_name TEXT; BEGIN
  FOREACH role_name IN ARRAY ARRAY['anon','authenticated'] LOOP
    IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname=role_name) THEN
      EXECUTE format('REVOKE ALL ON public.direct_communication_keys,public.direct_calls,public.direct_call_slots,public.direct_call_commands,public.direct_call_signals FROM %I',role_name);
    END IF;
  END LOOP;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN
    GRANT SELECT,INSERT,UPDATE,DELETE ON public.direct_communication_keys,public.direct_calls,
      public.direct_call_slots,public.direct_call_commands,public.direct_call_signals TO service_role;
    GRANT USAGE,SELECT ON SEQUENCE public.direct_call_signals_sequence_seq TO service_role;
  END IF;
END $$;
COMMIT;
