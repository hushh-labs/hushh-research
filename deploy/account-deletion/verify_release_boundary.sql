\set ON_ERROR_STOP on
SET statement_timeout = '5min';

-- This verifier is safe to run while UAT is serving: it inspects catalog state
-- and uses statement-level, zero-row DELETE probes only.
DO $verify$
DECLARE
  enabled_fence_count integer;
  enabled_tombstone_trigger_count integer;
  event_trigger_enabled "char";
  presence_primary_key_ready boolean;
  guarded_table record;
  insert_comment text;
  insert_enabled "char";
  insert_function_oid oid;
  insert_trigger_type smallint;
  insert_trigger_attributes text;
  update_comment text;
  update_enabled "char";
  update_function_oid oid;
  update_trigger_type smallint;
  update_trigger_attributes text;
  expected_function_oid oid :=
    'public.reject_deleted_account_identity_write()'::regprocedure::oid;
  identity_column_name text;
  missing_presence_count bigint;
BEGIN
  IF to_regclass('public.account_deletion_tombstones') IS NULL
     OR to_regclass('public.account_identity_presence') IS NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = 'account deletion lifecycle tables are missing';
  END IF;

  SELECT count(*)
    INTO enabled_fence_count
    FROM pg_trigger trigger_state
    JOIN pg_class table_state ON table_state.oid = trigger_state.tgrelid
    JOIN pg_namespace schema_state ON schema_state.oid = table_state.relnamespace
   WHERE schema_state.nspname = 'public'
     AND table_state.relname IN ('actor_profiles', 'vault_keys')
     AND trigger_state.tgname = 'trg_block_account_deletion_during_release'
     AND trigger_state.tgenabled = 'O'
     AND NOT trigger_state.tgisinternal;
  IF enabled_fence_count <> 2 THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = 'account deletion release fence is not enabled on both roots';
  END IF;

  SELECT count(*)
    INTO enabled_tombstone_trigger_count
    FROM pg_trigger trigger_state
    JOIN pg_class table_state ON table_state.oid = trigger_state.tgrelid
    JOIN pg_namespace schema_state ON schema_state.oid = table_state.relnamespace
   WHERE schema_state.nspname = 'public'
     AND table_state.relname IN ('actor_profiles', 'vault_keys')
     AND trigger_state.tgname = 'trg_record_account_deletion_tombstone'
     AND trigger_state.tgenabled = 'O'
     AND NOT trigger_state.tgisinternal;
  IF enabled_tombstone_trigger_count <> 2 THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = 'account deletion tombstone trigger is not enabled on both roots';
  END IF;

  SELECT evtenabled
    INTO event_trigger_enabled
    FROM pg_event_trigger
   WHERE evtname = 'trg_refresh_account_deletion_guards_after_identity_ddl';
  IF event_trigger_enabled IS DISTINCT FROM 'O' THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = 'account deletion identity guard event trigger is not enabled';
  END IF;

  SELECT index_state.indisprimary
         AND index_state.indisvalid
         AND index_state.indisready
    INTO presence_primary_key_ready
    FROM pg_index index_state
    JOIN pg_class table_state ON table_state.oid = index_state.indrelid
    JOIN pg_namespace schema_state ON schema_state.oid = table_state.relnamespace
   WHERE schema_state.nspname = 'public'
     AND table_state.relname = 'account_identity_presence'
     AND index_state.indexrelid =
       'public.account_identity_presence_pkey'::regclass;
  IF presence_primary_key_ready IS DISTINCT FROM true THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = 'account identity presence primary key is not valid and ready';
  END IF;

  -- Mirror migration 201's audited live-catalog inventory. Every eligible
  -- scalar identity table must carry the exact v3 INSERT and UPDATE trigger
  -- shape, function OID, enabled state, column attributes and signature.
  FOR guarded_table IN
    SELECT
      table_class.oid AS table_oid,
      table_namespace.nspname AS schema_name,
      table_class.relname AS table_name,
      array_agg(
        table_column.attname
        ORDER BY table_column.attname::text COLLATE "C"
      ) AS identity_columns,
      array_agg(
        table_column.attnum
        ORDER BY table_column.attname::text COLLATE "C"
      ) AS identity_column_attnums
    FROM pg_class table_class
    JOIN pg_namespace table_namespace
      ON table_namespace.oid = table_class.relnamespace
    JOIN pg_attribute table_column
      ON table_column.attrelid = table_class.oid
    JOIN pg_type declared_type
      ON declared_type.oid = table_column.atttypid
    LEFT JOIN pg_type base_type
      ON base_type.oid = declared_type.typbasetype
    WHERE table_namespace.nspname = 'public'
      AND table_class.relkind IN ('r', 'p')
      AND NOT table_class.relispartition
      AND table_class.relname <> 'account_deletion_tombstones'
      AND table_column.attnum > 0
      AND NOT table_column.attisdropped
      AND table_column.attgenerated = ''
      AND (
        table_column.attname ~
          '(^user_id$|^firebase_uid$|^user_[a-z0-9]+_id$|_user_id$|_firebase_uid$)'
        OR (
          table_class.relname = 'consent_audit_receipts'
          AND table_column.attname = 'subject_id'
        )
      )
      AND (
        COALESCE(base_type.typcategory, declared_type.typcategory) = 'S'
        OR COALESCE(NULLIF(declared_type.typbasetype, 0), declared_type.oid)
          = 'uuid'::regtype
      )
    GROUP BY table_class.oid, table_namespace.nspname, table_class.relname
    ORDER BY table_namespace.nspname::text COLLATE "C",
             table_class.relname::text COLLATE "C"
  LOOP
    SELECT
      obj_description(trigger_state.oid, 'pg_trigger'),
      trigger_state.tgenabled,
      trigger_state.tgfoid,
      trigger_state.tgtype,
      trigger_state.tgattr::text
    INTO
      insert_comment,
      insert_enabled,
      insert_function_oid,
      insert_trigger_type,
      insert_trigger_attributes
    FROM pg_trigger trigger_state
    WHERE trigger_state.tgrelid = guarded_table.table_oid
      AND trigger_state.tgname = 'trg_reject_deleted_account_insert'
      AND NOT trigger_state.tgisinternal;

    IF insert_comment IS DISTINCT FROM
         'hushh.account-deletion-guard/v3/insert-presence:' ||
         array_to_string(guarded_table.identity_columns, ',')
       OR insert_enabled IS DISTINCT FROM 'O'
       OR insert_function_oid IS DISTINCT FROM expected_function_oid
       OR insert_trigger_type IS DISTINCT FROM 7
       OR insert_trigger_attributes IS DISTINCT FROM '' THEN
      RAISE EXCEPTION USING
        ERRCODE = '55000',
        MESSAGE = format(
          'account deletion INSERT guard mismatch on %I.%I',
          guarded_table.schema_name,
          guarded_table.table_name
        );
    END IF;

    SELECT
      obj_description(trigger_state.oid, 'pg_trigger'),
      trigger_state.tgenabled,
      trigger_state.tgfoid,
      trigger_state.tgtype,
      trigger_state.tgattr::text
    INTO
      update_comment,
      update_enabled,
      update_function_oid,
      update_trigger_type,
      update_trigger_attributes
    FROM pg_trigger trigger_state
    WHERE trigger_state.tgrelid = guarded_table.table_oid
      AND trigger_state.tgname =
        'trg_reject_deleted_account_reference_update'
      AND NOT trigger_state.tgisinternal;

    IF update_comment IS DISTINCT FROM
         'hushh.account-deletion-guard/v3/update-bind-immutable:' ||
         array_to_string(guarded_table.identity_columns, ',')
       OR update_enabled IS DISTINCT FROM 'O'
       OR update_function_oid IS DISTINCT FROM expected_function_oid
       OR update_trigger_type IS DISTINCT FROM 19
       OR update_trigger_attributes IS DISTINCT FROM
         array_to_string(guarded_table.identity_column_attnums, ' ') THEN
      RAISE EXCEPTION USING
        ERRCODE = '55000',
        MESSAGE = format(
          'account deletion UPDATE guard mismatch on %I.%I',
          guarded_table.schema_name,
          guarded_table.table_name
        );
    END IF;

    FOREACH identity_column_name IN ARRAY guarded_table.identity_columns LOOP
      EXECUTE format(
        $presence_check$
        SELECT count(*)
        FROM %I.%I identity_row
        WHERE identity_row.%I IS NOT NULL
          AND btrim(identity_row.%I::text) <> ''
          AND NOT EXISTS (
            SELECT 1
            FROM public.account_identity_presence presence
            WHERE presence.user_id_hash =
              'sha256:' || encode(
                digest(identity_row.%I::text, 'sha256'),
                'hex'
              )
          )
        $presence_check$,
        guarded_table.schema_name,
        guarded_table.table_name,
        identity_column_name,
        identity_column_name,
        identity_column_name
      ) INTO missing_presence_count;
      IF missing_presence_count <> 0 THEN
        RAISE EXCEPTION USING
          ERRCODE = '55000',
          MESSAGE = format(
            'account identity presence backfill incomplete on %I.%I.%I',
            guarded_table.schema_name,
            guarded_table.table_name,
            identity_column_name
          );
      END IF;
    END LOOP;
  END LOOP;

  BEGIN
    DELETE FROM public.actor_profiles WHERE false;
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = 'actor_profiles account deletion release fence did not fire';
  EXCEPTION WHEN SQLSTATE '55000' THEN
    NULL;
  END;

  BEGIN
    DELETE FROM public.vault_keys WHERE false;
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = 'vault_keys account deletion release fence did not fire';
  EXCEPTION WHEN SQLSTATE '55000' THEN
    NULL;
  END;
END;
$verify$;

SELECT json_build_object(
  'status', 'ready_for_bridge_activation',
  'fence_triggers', 2,
  'tombstone_triggers', 2,
  'identity_ddl_guard', 'enabled'
) AS account_deletion_release_boundary;
