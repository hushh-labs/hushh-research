BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Durable account-erasure suppression and Firebase cleanup intent. The hash is
-- retained as the minimum lookup key needed to prevent a deleted Firebase UID
-- from recreating application rows. The raw UID exists only while external
-- Firebase cleanup remains pending and is scrubbed after completion.
CREATE TABLE IF NOT EXISTS account_deletion_tombstones (
  user_id_hash TEXT PRIMARY KEY
    CHECK (user_id_hash ~ '^sha256:[0-9a-f]{64}$'),
  firebase_uid TEXT,
  cleanup_intent_kind TEXT NOT NULL DEFAULT 'full_account'
    CHECK (cleanup_intent_kind IN ('full_account', 'phone_orphan')),
  expected_phone_digest TEXT,
  cleanup_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (cleanup_status IN (
      'pending',
      'running',
      'quarantined',
      'retry_pending',
      'completed'
    )),
  cleanup_attempt_count INTEGER NOT NULL DEFAULT 0
    CHECK (cleanup_attempt_count >= 0),
  cleanup_next_attempt_at TIMESTAMPTZ,
  cleanup_claimed_at TIMESTAMPTZ,
  cleanup_claim_token UUID,
  cleanup_last_attempt_at TIMESTAMPTZ,
  cleanup_last_outcome TEXT,
  cleanup_last_failure_class TEXT,
  cleanup_last_classification TEXT,
  deleted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (firebase_uid IS NULL OR char_length(firebase_uid) BETWEEN 1 AND 128),
  CHECK (
    (cleanup_intent_kind = 'full_account' AND expected_phone_digest IS NULL)
    OR (
      cleanup_intent_kind = 'phone_orphan'
      AND (
        (firebase_uid IS NULL AND expected_phone_digest IS NULL)
        OR (
          firebase_uid IS NOT NULL
          AND expected_phone_digest ~ '^hmac-sha256:[0-9a-f]{64}$'
        )
      )
    )
  ),
  CHECK (cleanup_last_failure_class IS NULL OR char_length(cleanup_last_failure_class) <= 120),
  CHECK (
    cleanup_last_classification IS NULL
    OR cleanup_last_classification ~ '^[a-z0-9_]{1,120}$'
  ),
  CHECK (cleanup_status <> 'completed' OR firebase_uid IS NULL),
  CHECK ((cleanup_status = 'running') = (cleanup_claim_token IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS idx_account_deletion_cleanup_due
  ON account_deletion_tombstones (cleanup_next_attempt_at, deleted_at)
  WHERE firebase_uid IS NOT NULL AND cleanup_status <> 'completed';

COMMENT ON TABLE account_deletion_tombstones IS
  'Minimal account-erasure tombstone and durable Firebase cleanup intent. Stores a SHA-256 UID digest indefinitely for resurrection suppression; raw Firebase UID and a domain-separated keyed phone proof exist only until external identity cleanup reaches a terminal outcome. Never stores email, raw phone number, token, provider profile, vault material, or error messages.';

COMMENT ON COLUMN account_deletion_tombstones.expected_phone_digest IS
  'Domain-separated HMAC-SHA256 proof used only to revalidate an exact phone-orphan UID before destructive cleanup; never a raw or unkeyed phone value and scrubbed with the raw Firebase UID.';

COMMENT ON COLUMN account_deletion_tombstones.cleanup_last_failure_class IS
  'Sanitized exception class only; never an exception message, credential, token, or provider payload.';

-- An exact, indexed negative lookup for the phone-session safety preflight.
-- The initial installer backfills every catalog-discovered identity column;
-- thereafter the same write guard records the first sighting of a UID. This
-- avoids scanning every account table for the normal absent phone-session UID
-- while still protecting legacy accounts that have no actor/vault root. The
-- marker is intentionally monotonic: a UID that ever owned or referenced app
-- state is never later treated as a disposable authentication-only identity.
CREATE TABLE IF NOT EXISTS account_identity_presence (
  user_id_hash TEXT PRIMARY KEY
    CHECK (user_id_hash ~ '^sha256:[0-9a-f]{64}$'),
  first_observed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE account_identity_presence IS
  'Monotonic SHA-256 Firebase/account UID presence registry maintained by migration-201 guards. Contains no raw UID or account payload; used only for indexed fail-closed phone-orphan cleanup preflight.';

REVOKE ALL ON TABLE account_identity_presence FROM PUBLIC;

-- This trigger closes the migration-first rolling-deploy window: old runtime
-- revisions do not know how to insert the tombstone, but deleting the root
-- actor identity uniquely denotes full account erasure. Persona removal and
-- account reset update this row instead. There is deliberately no bypass for
-- delete/recreate repair scripts; restoring a deleted UID would violate the
-- account-erasure contract.
CREATE OR REPLACE FUNCTION public.record_account_deletion_tombstone()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  -- Namespace 171 is the established graph-mutation barrier. Every deletion
  -- path takes it before namespace 198 so a rolling old writer cannot cross
  -- the cleanup/tombstone boundary or invert the lock order.
  PERFORM pg_advisory_xact_lock(hashtextextended(OLD.user_id, 171));
  PERFORM pg_advisory_xact_lock(hashtextextended(OLD.user_id, 198));
  INSERT INTO public.account_deletion_tombstones (
    user_id_hash,
    firebase_uid,
    cleanup_status,
    cleanup_next_attempt_at,
    deleted_at,
    updated_at
  )
  VALUES (
    'sha256:' || encode(digest(OLD.user_id, 'sha256'), 'hex'),
    OLD.user_id,
    'pending',
    NOW() + INTERVAL '1 minute',
    NOW(),
    NOW()
  )
  ON CONFLICT (user_id_hash) DO NOTHING;
  RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS trg_record_account_deletion_tombstone ON actor_profiles;
CREATE TRIGGER trg_record_account_deletion_tombstone
  BEFORE DELETE ON actor_profiles
  FOR EACH ROW EXECUTE FUNCTION public.record_account_deletion_tombstone();

-- Old revisions can legitimately encounter a legacy account with no
-- actor_profiles row while a VAULT_OWNER row still exists. vault_keys is the
-- second full-erasure root, so either old-runtime delete order records the
-- same idempotent tombstone before its final account spine disappears.
DROP TRIGGER IF EXISTS trg_record_account_deletion_tombstone ON vault_keys;
CREATE TRIGGER trg_record_account_deletion_tombstone
  BEFORE DELETE ON vault_keys
  FOR EACH ROW EXECUTE FUNCTION public.record_account_deletion_tombstone();

-- Defense in depth beneath route authentication: stale owner tokens and
-- concurrent bootstrap paths cannot recreate account-owned or account-
-- referenced rows after a tombstone commits. The trigger is generic so every
-- current scalar Firebase/account UID column can share the same enforcement
-- semantics without duplicating them across services.
CREATE OR REPLACE FUNCTION reject_deleted_account_identity_write()
RETURNS TRIGGER
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  identity_column_name TEXT;
  candidate_user_id TEXT;
  previous_user_id TEXT;
  candidate_user_ids TEXT[] := ARRAY[]::TEXT[];
BEGIN
  IF TG_LEVEL <> 'ROW'
     OR TG_OP NOT IN ('INSERT', 'UPDATE')
     OR TG_NARGS < 1 THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'invalid account deletion guard configuration';
  END IF;

  -- A query issued by a VOLATILE function gets a fresh command snapshot after
  -- an advisory-lock wait under READ COMMITTED. A transaction-level snapshot
  -- could otherwise predate the just-committed tombstone, so fail closed when
  -- a caller selects an incompatible isolation level.
  IF current_setting('transaction_isolation') NOT IN (
    'read committed',
    'read uncommitted'
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '25001',
      MESSAGE = 'account deletion guard requires read committed isolation';
  END IF;

  FOREACH identity_column_name IN ARRAY TG_ARGV LOOP
    -- Dynamic identifier quoting extracts only the configured scalar column;
    -- converting NEW wholesale to JSONB would copy wide encrypted/blob rows.
    EXECUTE format('SELECT ($1).%I::TEXT', identity_column_name)
      INTO candidate_user_id
      USING NEW;
    candidate_user_id := NULLIF(BTRIM(candidate_user_id), '');

    IF TG_OP = 'UPDATE' THEN
      EXECUTE format('SELECT ($1).%I::TEXT', identity_column_name)
        INTO previous_user_id
        USING OLD;
      previous_user_id := NULLIF(BTRIM(previous_user_id), '');

      -- Full-account cleanup intentionally updates some rows after recording
      -- its tombstone (for example, revoking an invite before deleting it).
      -- Those updates do not change the identity column and therefore skip
      -- the guard. A non-NULL identity must never be detached or re-parented:
      -- a BEFORE UPDATE trigger already owns the row lock, so waiting for the
      -- OLD identity's advisory lock here could deadlock with deletion (which
      -- owns the advisory lock and is waiting to delete this row). Rejecting
      -- the reassignment immediately both preserves ownership and releases the
      -- row for the deletion transaction. NULL-to-identity binding remains a
      -- supported, guarded transition.
      IF candidate_user_id IS NOT DISTINCT FROM previous_user_id THEN
        CONTINUE;
      END IF;
      IF previous_user_id IS NOT NULL THEN
        -- PostgreSQL implements ON DELETE SET NULL as a row UPDATE. Permit
        -- that detach only inside/after account erasure, where the deleting
        -- transaction has already recorded the OLD UID tombstone. An ordinary
        -- writer racing a still-uncommitted deletion sees no tombstone,
        -- rejects immediately, and releases its tuple lock instead of
        -- deadlocking with the deletion's exclusive advisory lock.
        IF candidate_user_id IS NULL AND EXISTS (
          SELECT 1
          FROM public.account_deletion_tombstones
          WHERE user_id_hash =
            'sha256:' || encode(digest(previous_user_id, 'sha256'), 'hex')
        ) THEN
          CONTINUE;
        END IF;
        RAISE EXCEPTION USING
          ERRCODE = '23514',
          MESSAGE = 'account identity reference is immutable',
          CONSTRAINT = 'account_identity_reference_immutable_guard';
      END IF;
    END IF;

    IF candidate_user_id IS NOT NULL THEN
      candidate_user_ids := array_append(
        candidate_user_ids,
        candidate_user_id
      );
    END IF;
  END LOOP;

  -- Namespace 171 is already used by connection-graph writers and old
  -- deletion revisions. Acquire every shared 171 lock first, in stable order,
  -- so a writer that started after cleanup began blocks before it can cross
  -- into namespace 198.
  FOR candidate_user_id IN
    SELECT DISTINCT configured_user_id COLLATE "C"
    FROM unnest(candidate_user_ids) AS configured(configured_user_id)
    ORDER BY 1
  LOOP
    PERFORM pg_advisory_xact_lock_shared(
      hashtextextended(candidate_user_id, 171)
    );
  END LOOP;

  -- Writers for the same UID may proceed together. Account deletion takes the
  -- matching exclusive locks in namespace order, so it waits for prior writes
  -- and new writes wait for its tombstone. Stable UID ordering prevents
  -- relationship rows from introducing a per-row A/B lock inversion.
  FOR candidate_user_id IN
    SELECT DISTINCT configured_user_id COLLATE "C"
    FROM unnest(candidate_user_ids) AS configured(configured_user_id)
    ORDER BY 1
  LOOP
    PERFORM pg_advisory_xact_lock_shared(
      hashtextextended(candidate_user_id, 198)
    );
  END LOOP;

  -- Probe after all locks are held. Under READ COMMITTED this observes a
  -- tombstone that committed while the writer was waiting for deletion.
  FOR candidate_user_id IN
    SELECT DISTINCT configured_user_id COLLATE "C"
    FROM unnest(candidate_user_ids) AS configured(configured_user_id)
    ORDER BY 1
  LOOP
    IF EXISTS (
      SELECT 1
      FROM public.account_deletion_tombstones
      WHERE user_id_hash =
        'sha256:' || encode(digest(candidate_user_id, 'sha256'), 'hex')
    ) THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'account identity is deleted',
        CONSTRAINT = 'account_deletion_tombstone_guard';
    END IF;

    -- Most writes hit an existing marker and pay only an indexed lookup. The
    -- conditional insert prevents high-volume per-user event streams from
    -- serializing on a redundant ON CONFLICT update/insert attempt.
    INSERT INTO public.account_identity_presence (user_id_hash)
    SELECT 'sha256:' || encode(digest(candidate_user_id, 'sha256'), 'hex')
    WHERE NOT EXISTS (
      SELECT 1
      FROM public.account_identity_presence
      WHERE user_id_hash =
        'sha256:' || encode(digest(candidate_user_id, 'sha256'), 'hex')
    )
    ON CONFLICT (user_id_hash) DO NOTHING;
  END LOOP;

  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION reject_deleted_account_identity_write() IS
  'Rejects INSERTs and NULL-to-identity bindings for accounts with durable deletion tombstones, rejects non-NULL identity reassignment, and permits identity-to-NULL only after the OLD UID tombstone exists for deletion FK cleanup. Trigger arguments are audited identity-column names.';

-- Install guards from the live schema rather than a deployment-profile-
-- specific table list. Prod, UAT, and development intentionally have different
-- optional tables. Only persisted scalar TEXT/UUID-like identity columns are
-- eligible; opaque JSON/arrays and the separate legacy_user_uuid namespace are
-- deliberately outside this contract.
CREATE OR REPLACE FUNCTION install_account_deletion_write_guards()
RETURNS INTEGER
LANGUAGE plpgsql
VOLATILE
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  guarded_table RECORD;
  legacy_trigger RECORD;
  identity_columns_sql TEXT;
  trigger_arguments_sql TEXT;
  insert_signature TEXT;
  update_signature TEXT;
  existing_comment TEXT;
  existing_enabled "char";
  existing_function_oid OID;
  existing_trigger_type SMALLINT;
  existing_trigger_attributes TEXT;
  expected_update_attributes TEXT;
  guard_refreshed BOOLEAN;
  identity_column_name TEXT;
  expected_function_oid OID :=
    'public.reject_deleted_account_identity_write()'::regprocedure::OID;
  guarded_table_count INTEGER := 0;
BEGIN
  -- BEFORE triggers cannot inspect the computed value of a generated column.
  -- Stop the migration instead of silently leaving a generated UID unguarded.
  IF EXISTS (
    SELECT 1
    FROM pg_class AS table_class
    JOIN pg_namespace AS table_namespace
      ON table_namespace.oid = table_class.relnamespace
    JOIN pg_attribute AS table_column
      ON table_column.attrelid = table_class.oid
    WHERE table_namespace.nspname = 'public'
      AND table_class.relkind IN ('r', 'p')
      AND NOT table_class.relispartition
      AND table_class.relname <> 'account_deletion_tombstones'
      AND table_column.attnum > 0
      AND NOT table_column.attisdropped
      AND table_column.attgenerated <> ''
      AND (
        table_column.attname ~
          '(^user_id$|^firebase_uid$|^user_[a-z0-9]+_id$|_user_id$|_firebase_uid$)'
        OR (
          table_class.relname = 'consent_audit_receipts'
          AND table_column.attname = 'subject_id'
        )
      )
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = 'generated account identity columns require an explicit deletion guard';
  END IF;

  FOR guarded_table IN
    SELECT
      table_class.oid AS table_oid,
      table_namespace.nspname AS schema_name,
      table_class.relname AS table_name,
      array_agg(
        table_column.attname
        ORDER BY table_column.attname::TEXT COLLATE "C"
      )
        AS identity_columns,
      array_agg(
        table_column.attnum
        ORDER BY table_column.attname::TEXT COLLATE "C"
      ) AS identity_column_attnums
    FROM pg_class AS table_class
    JOIN pg_namespace AS table_namespace
      ON table_namespace.oid = table_class.relnamespace
    JOIN pg_attribute AS table_column
      ON table_column.attrelid = table_class.oid
    JOIN pg_type AS declared_type
      ON declared_type.oid = table_column.atttypid
    LEFT JOIN pg_type AS base_type
      ON base_type.oid = declared_type.typbasetype
    WHERE table_namespace.nspname = 'public'
      AND table_class.relkind IN ('r', 'p')
      -- Parent row triggers are cloned to existing and future partitions.
      AND NOT table_class.relispartition
      -- A tombstone write must never recursively guard itself.
      AND table_class.relname <> 'account_deletion_tombstones'
      AND table_column.attnum > 0
      AND NOT table_column.attisdropped
      AND table_column.attgenerated = ''
      AND (
        table_column.attname ~
          '(^user_id$|^firebase_uid$|^user_[a-z0-9]+_id$|_user_id$|_firebase_uid$)'
        -- Parked migration 904 defines this as the raw consent subject UID.
        -- Its generic name is an audited exception, not permission to infer
        -- that every future subject_id column belongs to the account namespace.
        OR (
          table_class.relname = 'consent_audit_receipts'
          AND table_column.attname = 'subject_id'
        )
      )
      AND (
        COALESCE(base_type.typcategory, declared_type.typcategory) = 'S'
        OR COALESCE(
          NULLIF(declared_type.typbasetype, 0),
          declared_type.oid
        ) = 'uuid'::regtype
      )
    GROUP BY table_class.oid, table_namespace.nspname, table_class.relname
    ORDER BY table_namespace.nspname::TEXT COLLATE "C",
             table_class.relname::TEXT COLLATE "C"
  LOOP
    guard_refreshed := FALSE;
    SELECT
      string_agg(
        format('%I', configured_column.identity_column_name),
        ', '
        ORDER BY configured_column.identity_column_name::TEXT COLLATE "C"
      ),
      string_agg(
        format('%L', configured_column.identity_column_name),
        ', '
        ORDER BY configured_column.identity_column_name::TEXT COLLATE "C"
      )
    INTO identity_columns_sql, trigger_arguments_sql
    FROM unnest(guarded_table.identity_columns)
      AS configured_column(identity_column_name);

    insert_signature :=
      'hushh.account-deletion-guard/v3/insert-presence:' ||
      array_to_string(guarded_table.identity_columns, ',');
    update_signature :=
      'hushh.account-deletion-guard/v3/update-bind-immutable:' ||
      array_to_string(guarded_table.identity_columns, ',');
    expected_update_attributes :=
      array_to_string(guarded_table.identity_column_attnums, ' ');

    SELECT
      obj_description(guard_trigger.oid, 'pg_trigger'),
      guard_trigger.tgenabled,
      guard_trigger.tgfoid,
      guard_trigger.tgtype,
      guard_trigger.tgattr::TEXT
    INTO
      existing_comment,
      existing_enabled,
      existing_function_oid,
      existing_trigger_type,
      existing_trigger_attributes
    FROM pg_trigger AS guard_trigger
    WHERE guard_trigger.tgrelid = guarded_table.table_oid
      AND guard_trigger.tgname = 'trg_reject_deleted_account_insert'
      AND NOT guard_trigger.tgisinternal
    LIMIT 1;

    IF existing_comment IS DISTINCT FROM insert_signature
       OR existing_enabled IS DISTINCT FROM 'O'
       OR existing_function_oid IS DISTINCT FROM expected_function_oid
       OR existing_trigger_type IS DISTINCT FROM 7
       OR existing_trigger_attributes IS DISTINCT FROM '' THEN
      EXECUTE format(
        'DROP TRIGGER IF EXISTS %I ON %I.%I',
        'trg_reject_deleted_account_insert',
        guarded_table.schema_name,
        guarded_table.table_name
      );
      EXECUTE format(
        'CREATE TRIGGER %I BEFORE INSERT ON %I.%I '
        'FOR EACH ROW EXECUTE FUNCTION '
        'public.reject_deleted_account_identity_write(%s)',
        'trg_reject_deleted_account_insert',
        guarded_table.schema_name,
        guarded_table.table_name,
        trigger_arguments_sql
      );
      EXECUTE format(
        'COMMENT ON TRIGGER %I ON %I.%I IS %L',
        'trg_reject_deleted_account_insert',
        guarded_table.schema_name,
        guarded_table.table_name,
        insert_signature
      );
      guard_refreshed := TRUE;
    END IF;

    SELECT
      obj_description(guard_trigger.oid, 'pg_trigger'),
      guard_trigger.tgenabled,
      guard_trigger.tgfoid,
      guard_trigger.tgtype,
      guard_trigger.tgattr::TEXT
    INTO
      existing_comment,
      existing_enabled,
      existing_function_oid,
      existing_trigger_type,
      existing_trigger_attributes
    FROM pg_trigger AS guard_trigger
    WHERE guard_trigger.tgrelid = guarded_table.table_oid
      AND guard_trigger.tgname =
        'trg_reject_deleted_account_reference_update'
      AND NOT guard_trigger.tgisinternal
    LIMIT 1;

    IF existing_comment IS DISTINCT FROM update_signature
       OR existing_enabled IS DISTINCT FROM 'O'
       OR existing_function_oid IS DISTINCT FROM expected_function_oid
       OR existing_trigger_type IS DISTINCT FROM 19
       OR existing_trigger_attributes IS DISTINCT FROM expected_update_attributes THEN
      EXECUTE format(
        'DROP TRIGGER IF EXISTS %I ON %I.%I',
        'trg_reject_deleted_account_reference_update',
        guarded_table.schema_name,
        guarded_table.table_name
      );
      EXECUTE format(
        'CREATE TRIGGER %I BEFORE UPDATE OF %s ON %I.%I '
        'FOR EACH ROW EXECUTE FUNCTION '
        'public.reject_deleted_account_identity_write(%s)',
        'trg_reject_deleted_account_reference_update',
        identity_columns_sql,
        guarded_table.schema_name,
        guarded_table.table_name,
        trigger_arguments_sql
      );
      EXECUTE format(
        'COMMENT ON TRIGGER %I ON %I.%I IS %L',
        'trg_reject_deleted_account_reference_update',
        guarded_table.schema_name,
        guarded_table.table_name,
        update_signature
      );
      guard_refreshed := TRUE;
    END IF;

    -- Trigger replacement takes a write-conflicting table lock. Backfill only
    -- under that versioned transition: existing v3 tables avoid repeat scans,
    -- while CREATE TABLE AS / ALTER TABLE UID additions cannot commit without
    -- registering every pre-existing identity in the same transaction.
    IF guard_refreshed THEN
      FOREACH identity_column_name IN ARRAY guarded_table.identity_columns LOOP
        EXECUTE format(
          $presence_backfill$
          INSERT INTO public.account_identity_presence (user_id_hash)
          SELECT DISTINCT
            'sha256:' || encode(
              digest(NULLIF(BTRIM(%1$I::TEXT), ''), 'sha256'),
              'hex'
            )
          FROM %2$I.%3$I
          WHERE NULLIF(BTRIM(%1$I::TEXT), '') IS NOT NULL
          ON CONFLICT (user_id_hash) DO NOTHING
          $presence_backfill$,
          identity_column_name,
          guarded_table.schema_name,
          guarded_table.table_name
        );
      END LOOP;
    END IF;

    guarded_table_count := guarded_table_count + 1;
  END LOOP;

  IF guarded_table_count = 0 THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = 'no account identity columns were found for deletion guards';
  END IF;

  -- Retire the five pre-inventory triggers without taking write-conflicting
  -- locks on every replay once they are gone.
  FOR legacy_trigger IN
    SELECT
      table_namespace.nspname AS schema_name,
      table_class.relname AS table_name,
      guard_trigger.tgname AS trigger_name
    FROM pg_trigger AS guard_trigger
    JOIN pg_class AS table_class
      ON table_class.oid = guard_trigger.tgrelid
    JOIN pg_namespace AS table_namespace
      ON table_namespace.oid = table_class.relnamespace
    WHERE table_namespace.nspname = 'public'
      AND NOT table_class.relispartition
      AND NOT guard_trigger.tgisinternal
      AND guard_trigger.tgname IN (
        'trg_reject_deleted_actor_profile_write',
        'trg_reject_deleted_actor_identity_write',
        'trg_reject_deleted_runtime_persona_write',
        'trg_reject_deleted_vault_write',
        'trg_reject_deleted_push_token_write'
      )
  LOOP
    EXECUTE format(
      'DROP TRIGGER IF EXISTS %I ON %I.%I',
      legacy_trigger.trigger_name,
      legacy_trigger.schema_name,
      legacy_trigger.table_name
    );
  END LOOP;

  RETURN guarded_table_count;
END;
$$;

COMMENT ON FUNCTION install_account_deletion_write_guards() IS
  'Idempotently installs deletion-tombstone INSERT and immutable-reference UPDATE guards on all public scalar account/Firebase UID columns, and transactionally backfills the indexed UID-presence registry when a versioned guard changes.';

REVOKE EXECUTE ON FUNCTION install_account_deletion_write_guards() FROM PUBLIC;

DO $$
BEGIN
  PERFORM public.install_account_deletion_write_guards();
END;
$$;

-- Keep the inventory complete after migration 201. Several legacy services
-- still carry idempotent runtime CREATE TABLE safety nets, and future schema
-- migrations can add a UID column after this one has shipped. Refreshing at
-- ddl_command_end makes the new/altered table and its guard visible atomically;
-- a generated or otherwise unsupported identity shape aborts the DDL instead
-- of opening a resurrection gap. CREATE TRIGGER is deliberately not in the tag
-- filter, so the installer cannot recursively invoke this event trigger.
CREATE OR REPLACE FUNCTION public.refresh_account_deletion_guards_after_identity_ddl()
RETURNS event_trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  PERFORM public.install_account_deletion_write_guards();
END;
$$;

REVOKE ALL ON FUNCTION public.refresh_account_deletion_guards_after_identity_ddl()
  FROM PUBLIC;

DROP EVENT TRIGGER IF EXISTS trg_refresh_account_deletion_guards_after_identity_ddl;
CREATE EVENT TRIGGER trg_refresh_account_deletion_guards_after_identity_ddl
  ON ddl_command_end
  WHEN TAG IN ('CREATE TABLE', 'CREATE TABLE AS', 'SELECT INTO', 'ALTER TABLE')
  EXECUTE FUNCTION public.refresh_account_deletion_guards_after_identity_ddl();

COMMIT;
