-- One human-approved, single-use Browser credential fill uses the existing
-- private action ledger. No password, seed, new table or standing grant is stored.
-- All three lineage markers survive a missing or damaged individual constraint.
DO $browser_credential_fill$
BEGIN
 PERFORM set_config('lock_timeout','5s',true);
 LOCK TABLE public.one_action_directive_ledger IN ACCESS EXCLUSIVE MODE;
 IF EXISTS(SELECT 1 FROM pg_constraint WHERE
 conrelid=to_regclass('public.one_action_directive_ledger')
 AND (obj_description(oid,'pg_constraint')='browser-credential-fill.v1/467' OR
 (conname='pod_chat_action_identity' AND
 regexp_replace(pg_get_constraintdef(oid),'[[:space:]]','','g')=
 'CHECK(((channel<>''pod_chat''::text)OR((adk_app_nameISNULL)AND(action_id=ANY(ARRAY[''connector.mcp.invoke''::text,''browser.model_process''::text,''browser.disclose''::text,''browser.session_remember''::text,''browser.session_restore''::text,''browser.provider_safety''::text,''browser.credential_fill''::text]))ANDrequires_confirmationANDtrusted_activation_requiredAND(resource_binding_hmacISNOTNULL))))'))) THEN
  IF NOT (SELECT count(*)=3 FROM pg_constraint c
 JOIN (VALUES ('one_action_directive_ledger_channel_check','CHECK((channel=ANY(ARRAY[''typed_chat''::text,''voice''::text,''command''::text,''document_review''::text,''adk_chat''::text,''pod_chat''::text])))'),('one_action_directive_ledger_check','CHECK((((channel=''typed_chat''::text)AND(conversation_idISNOTNULL)AND(session_idISNULL))OR((channel=ANY(ARRAY[''voice''::text,''command''::text,''adk_chat''::text,''pod_chat''::text]))AND(session_idISNOTNULL)AND(conversation_idISNULL))OR((channel=''document_review''::text)AND(conversation_idISNULL)AND(session_idISNULL))))'),('pod_chat_action_identity','CHECK(((channel<>''pod_chat''::text)OR((adk_app_nameISNULL)AND(action_id=ANY(ARRAY[''connector.mcp.invoke''::text,''browser.model_process''::text,''browser.disclose''::text,''browser.session_remember''::text,''browser.session_restore''::text,''browser.provider_safety''::text,''browser.credential_fill''::text]))ANDrequires_confirmationANDtrusted_activation_requiredAND(resource_binding_hmacISNOTNULL))))')) AS expected(name,definition) ON c.conname=expected.name
 WHERE c.conrelid=to_regclass('public.one_action_directive_ledger')
 AND c.contype='c' AND c.convalidated
 AND regexp_replace(pg_get_constraintdef(c.oid),'[[:space:]]','','g')=expected.definition
 AND (obj_description(c.oid,'pg_constraint')='browser-credential-fill.v1/467')) THEN
 RAISE EXCEPTION 'Unqualified Browser credential authority successor';
 END IF;
  RETURN;
 END IF;
 IF NOT (SELECT count(*)=3 FROM pg_constraint c
 JOIN (VALUES ('one_action_directive_ledger_channel_check','CHECK((channel=ANY(ARRAY[''typed_chat''::text,''voice''::text,''command''::text,''document_review''::text,''adk_chat''::text,''pod_chat''::text])))'),('one_action_directive_ledger_check','CHECK((((channel=''typed_chat''::text)AND(conversation_idISNOTNULL)AND(session_idISNULL))OR((channel=ANY(ARRAY[''voice''::text,''command''::text,''adk_chat''::text,''pod_chat''::text]))AND(session_idISNOTNULL)AND(conversation_idISNULL))OR((channel=''document_review''::text)AND(conversation_idISNULL)AND(session_idISNULL))))'),('pod_chat_action_identity','CHECK(((channel<>''pod_chat''::text)OR((adk_app_nameISNULL)AND(action_id=ANY(ARRAY[''connector.mcp.invoke''::text,''browser.model_process''::text,''browser.disclose''::text,''browser.session_remember''::text,''browser.session_restore''::text,''browser.provider_safety''::text]))ANDrequires_confirmationANDtrusted_activation_requiredAND(resource_binding_hmacISNOTNULL))))')) AS expected(name,definition) ON c.conname=expected.name
 WHERE c.conrelid=to_regclass('public.one_action_directive_ledger')
 AND c.contype='c' AND c.convalidated
 AND regexp_replace(pg_get_constraintdef(c.oid),'[[:space:]]','','g')=expected.definition
 AND (CASE WHEN c.conname='pod_chat_action_identity' THEN obj_description(c.oid,'pg_constraint') IS NULL ELSE obj_description(c.oid,'pg_constraint') IN ('private-action-channel.v1/971','private-action-channel.v1/420') END)) THEN
  RAISE EXCEPTION 'Qualified private Browser predecessor is required';
 END IF;
 ALTER TABLE public.one_action_directive_ledger DROP CONSTRAINT pod_chat_action_identity;
 ALTER TABLE public.one_action_directive_ledger ADD CONSTRAINT pod_chat_action_identity CHECK (
    channel <> 'pod_chat' OR (
      adk_app_name IS NULL
      AND action_id IN (
        'connector.mcp.invoke', 'browser.model_process', 'browser.disclose',
        'browser.session_remember', 'browser.session_restore', 'browser.provider_safety', 'browser.credential_fill'
      )
      AND requires_confirmation AND trusted_activation_required
      AND resource_binding_hmac IS NOT NULL
    )
  );
 COMMENT ON CONSTRAINT one_action_directive_ledger_channel_check ON public.one_action_directive_ledger IS 'browser-credential-fill.v1/467';
 COMMENT ON CONSTRAINT one_action_directive_ledger_check ON public.one_action_directive_ledger IS 'browser-credential-fill.v1/467';
 COMMENT ON CONSTRAINT pod_chat_action_identity ON public.one_action_directive_ledger IS 'browser-credential-fill.v1/467';
 IF NOT (SELECT count(*)=3 FROM pg_constraint c
 JOIN (VALUES ('one_action_directive_ledger_channel_check','CHECK((channel=ANY(ARRAY[''typed_chat''::text,''voice''::text,''command''::text,''document_review''::text,''adk_chat''::text,''pod_chat''::text])))'),('one_action_directive_ledger_check','CHECK((((channel=''typed_chat''::text)AND(conversation_idISNOTNULL)AND(session_idISNULL))OR((channel=ANY(ARRAY[''voice''::text,''command''::text,''adk_chat''::text,''pod_chat''::text]))AND(session_idISNOTNULL)AND(conversation_idISNULL))OR((channel=''document_review''::text)AND(conversation_idISNULL)AND(session_idISNULL))))'),('pod_chat_action_identity','CHECK(((channel<>''pod_chat''::text)OR((adk_app_nameISNULL)AND(action_id=ANY(ARRAY[''connector.mcp.invoke''::text,''browser.model_process''::text,''browser.disclose''::text,''browser.session_remember''::text,''browser.session_restore''::text,''browser.provider_safety''::text,''browser.credential_fill''::text]))ANDrequires_confirmationANDtrusted_activation_requiredAND(resource_binding_hmacISNOTNULL))))')) AS expected(name,definition) ON c.conname=expected.name
 WHERE c.conrelid=to_regclass('public.one_action_directive_ledger')
 AND c.contype='c' AND c.convalidated
 AND regexp_replace(pg_get_constraintdef(c.oid),'[[:space:]]','','g')=expected.definition
 AND (obj_description(c.oid,'pg_constraint')='browser-credential-fill.v1/467')) THEN
 RAISE EXCEPTION 'Unqualified Browser credential authority successor';
 END IF;
END $browser_credential_fill$;
