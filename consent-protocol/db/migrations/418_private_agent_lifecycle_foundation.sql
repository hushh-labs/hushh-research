-- Final private-agent lifecycle foundation. No hosting choice or resource is created.
-- Expand canonical reader metadata; adopt only matching existing authority objects.
-- Preserve applied dev history, retained records, sequence positions and successor functions.
-- Canonical registry nullability is retained for legacy unplaced readers.
-- Source lineage (historical SQL is not replayed by this migration):

-- 900_personal_agent_registry.sql sha256:d58c728220b763c758da140f639c2cbdb8e29ad5900aad8ca98c07e55611f652

-- 901_agent_prompt_versions.sql sha256:df6bb7f3e902d8faa941e029e68cf7c1bdb220c6ed61ba947682e6c991c89ff1

-- 902_personal_agent_tombstone_hushh_id_index.sql sha256:d7bedcbb6acef7b53f93dc3392cb0b2dd1608ce227fe9c2d23c2a5e257107842

-- 903_webauthn_credentials.sql sha256:108943fddaf69131edacc999ec55ffa983920abbd8265d0a84c8241dad6867e1

-- 904_consent_audit_receipts.sql sha256:3dd91a54968b624471548ec97e90d18f254a86ced3b9d459501fc2fccc79fdaf

-- 905_personal_agent_liveness.sql sha256:98edfaa4b2cecebc0e53a87e3585b7bf08154b18bcfd53ab3ee280eeea028ba2

-- 906_personal_agent_user_cloud.sql sha256:529ed9f51226fde7ba4b2d52da347a94e703928f0fcb98e8a764353d74a2e6e9

-- 907_pod_lifecycle_events.sql sha256:ce29eca69e505dbb07b9cc662988a517a66ab3b3e459b7d92607e3fe4c0a1370

-- 908_personal_agent_tombstone_metadata.sql sha256:33fe99ecae912b85d5b1534d245c723d76f873ab9e13f401b261e0c282ce82cc

-- 909_byoc_setup_jobs.sql sha256:03a6178685a03c56bd39b7e53c073954d02fcb75d9baf00197c1a5a4c03732b3

-- 910_personal_agent_status_needs_reinit.sql sha256:e52896ca29f0f189ce11df2eb980024b0859eeb75f43c4dd5e4a724841a85125

-- 911_pod_migration_jobs.sql sha256:ce10e724abbcf94a12962432348b3dbc00fa1017c5089f7257bba6a93f12836f

-- 912_personal_agent_status_migrating.sql sha256:454c1ac009cc77eb4fefec49933f66a9aebd2a62eed2d65bb794ea4f6df23e4e

-- 913_consent_audit_receipts_ledger.sql sha256:5ab2f7722bbb50583ad78298289d1c975260b91184b1742aeb0c285a8a7bc8e4

-- 914_personal_agent_billing_space_id.sql sha256:6cd512624e279e75253bbfbd57ca647038e6509288e2a13f23642fbc2c5758c8

-- 915_personal_agent_renewal_authority.sql sha256:21d5741d3f9a2039b1e14b705a06e40f1fdb6faae9dedb9758e080fb94a0b70b

-- 916_personal_agent_erasure_admission.sql sha256:9534e2300bbe99ea74b80e6c78859e0bc2b992556916f058ae035fd561aa4497

-- 917_personal_agent_provision_admission.sql sha256:5c89255e1fe04acf180003f4ac7081314425d6d6509d63943d00dc3c360ee4f9

-- 918_personal_agent_erasure_memory_binding.sql sha256:8f900209a700e2fd1bcb130f56ba0e8588d40309ed07ce0190e8416e71bfe5db

-- 919_personal_agent_compute_erasure.sql sha256:4f858553a01bcce3cac63bd50b6c0f0d14f70cf0a8b8ef503bcdc60e3b51de87

-- 920_personal_agent_substrate_inventory.sql sha256:81b776deef29abf22570a47da321d9f590989d2f68df5cecabef51188d5c2c71

-- 921_personal_agent_writer_revocation.sql sha256:b787fc088145a69b2031d076b9ded5e699944c89f225a464244be97a2c4c24cc

-- 922_personal_agent_bucket_erasure.sql sha256:56bbcc105558f7f2545d23d4a6fce1fe84a1c820ce05d279920c686993a82ecc

-- 923_personal_agent_mail_erasure.sql sha256:2198254d0623e485a2a72db87052d6d65e2265b38bd2ec6c4bd356d3ee77690b

-- 924_personal_agent_kms_erasure.sql sha256:e72abdca6141da60de1a7a39716edfec78b5373513e485fb8964c932ccd82614

-- 925_personal_agent_secret_erasure.sql sha256:0ddf0a95558c4ea2ae59569f3eff2e22b4edba18ed6d7866ad046c66b7502039

-- 926_personal_agent_runtime_account_erasure.sql sha256:3461534f042b8b7a3c153e56ab3184b9d7598678dc4d0ee00519aa9cfa12b89e

-- 927_personal_agent_project_grant_fence.sql sha256:c4e3d9dbf1a0c6a5a214d9bb7ecea76b7d4b1c6aea1686cccda7af53de53b4c5

-- 928_byoc_authorization_receipts.sql sha256:8c56ae018b7f22903cf8dc1f7fd80b09bb1dd46cc8c84b230b7777b653013e9a

-- 929_personal_agent_runtime_grant_erasure.sql sha256:de2ada88e0348e0cda57654b66c983db753f9c0ac3613ad48d4deb29163af382

-- 930_personal_agent_repository_grant_erasure.sql sha256:3f8e92cb906c87458e0e86bddf205d3437b62e80065b04455f5d987af3f49408

-- 931_personal_agent_repository_inventory.sql sha256:7165af79b4345a47eb21b10f4f59e980edc096769f4f5e00991ed335a22f79a2

-- 932_personal_agent_repository_retention.sql sha256:c9e7ac1eff637707175d73f63f446f47ef39fc6fb7448b63758cc579ac5f2b34

-- 933_personal_agent_bootstrap_grant_erasure.sql sha256:db4fcb9926b7f59f2497eda6563364cc3e6ad221589af44896e685904218982f

-- 934_personal_agent_erasure_resource_coverage.sql sha256:d304e27b5372c6df43046ef02eb145e68fb664e312ea92026a81db991018e5d1

-- 935_personal_agent_erasure_finalization.sql sha256:c1870fc88e2b75b94d03605c2bbfb2bb960e95196ad7406e0e4b81eaa9cb7030

-- 936_personal_agent_stale_erasure_recovery.sql sha256:8ad93e01be960069f16cb3299e35e914abbb4b20557012b8602702941dd99005

-- 940_personal_agent_erasure_guard_composition.sql sha256:6fadddbbf5991ef614929810e7d21ea9cfa4d7437df8e16309a37d4f8d1da799

-- 941_personal_agent_files_erasure.sql sha256:5b161fdd694a5f861d0eb88c4447e778ef0418e71daef9ba7a2b72bc79cbf5ca

-- 942_personal_agent_erasure_validation_cost.sql sha256:ea9f2e4ab9768dfbfb834ee767d4faa7c184be815c11b2d8676199e525330044

-- 943_personal_agent_files_upgrade_evidence.sql sha256:ddd7badeafcf92139a86fc8e945f746ab16bd8c6b84c3eca4412a55b4d50b917

-- 945_pod_mcp_action_authority.sql sha256:e63d7e91193b0d4767f4ff81c35dc99b2ff93552e93c5252e468bb78d5597817

-- 946_personal_agent_files_provision_admission.sql sha256:0eb71ae423a83a39f0414e5f826a2ea129c7a1e830a3b60e779583d6c7c9e4d9

-- 947_pod_request_signing.sql sha256:2c63e6e9f9f395f96eeb981762102c37b8bcd3b137ae6dd36121b14301092dd0

-- 948_personal_agent_user_azure.sql sha256:fedab0e083f2fc4ef28ff61f41f9e505cc73083692aac517f6ca3cbaa88d62b9

-- 949_personal_agent_owner_access_erasure.sql sha256:12b21cd16f5d81e391be5dd476deb3c9526c4ee1e42d97e47493e51640737fb0

-- 950_personal_agent_standby_placements.sql sha256:dcac33844dcdb6e648c7a16e16b2ffdb6df13b7e347558c3f9a58080d68a5b92

-- 951_byoc_setup_job_azure_admission.sql sha256:64f652c27a79fc019e50a5931b0cb46b26938f255778300f059832e36f820ac1

-- 952_personal_agent_provision_after_detach.sql sha256:fd86a0eff13725304a8c54aff3ff14f98c2d3d9ad15f3ad738d82ae6bdb71661

-- 953_personal_agent_key_pull_during_attach.sql sha256:7116868fbae125419e9fa76008b344db235f91e9aa0f7b963817623996232ef2

-- 954_personal_agent_never_hosted_erasure.sql sha256:6a009b583f5ced70ad6e35a26ee21c96bb0f63371163def0ae9bce484e007bf6

-- 956_personal_agent_notification_checkpoint.sql sha256:a068606870a7d67dec83a97b859118b6c5c656aec092428011f8f4dec92738e5

-- 957_personal_agent_azure_files_upgrade.sql sha256:17fe6dbf77da8d702db738caffc6e5720c70e0a150ba4afc663f10ad72d86f9e

-- 959_shared_files_storage_lifecycle.sql sha256:baf98a9e14972bb52f40361ba3d27815b915298ec4f523d971bb934bc262764c

-- 960_owner_erasure_provider_outcomes.sql sha256:dc63535d194788dffcac85b21d44a99fa1be0d8ca28c09190c0351e08adb00b3

-- 961_azure_setup_erasure_binding.sql sha256:2b397b12adba5b83ba6f25863673189e5064cd59d049655fba72b7e2379816c9

-- 962_azure_owner_cleanup_admission.sql sha256:9c91b4744453d4f56939a3fb4e38c9f74864743ab95fdf6bed43b79552e8edd6

-- 963_personal_agent_operator_mail_custody.sql sha256:75970ddbd5ea44950015021bee10c6476bb6878bd8b5318c134574c789f7a01a

-- 964_personal_agent_runtime_quota_grant.sql sha256:6080bac7d44d3711a24c5014b118f4a6131e177b7ac31e39fcc49d05ab3d8e4c

-- 966_pod_browser_action_authority.sql sha256:e04b8367d7d92cf0d0dac4849f045b8f619d1d6cb74af8889e747551c6ab963f

-- 967_azure_vm_power_admission.sql sha256:a16d31409d625e306797d991106056d4ba3e9b6b57f0c3e60ccbe67f7e619e62

-- 968_azure_vm_image_update_admission.sql sha256:9c15f78476d4714439840e3c09c2a76d57121c19eb983242219529f255dc38c9

-- 969_gcp_browser_update_admission.sql sha256:90093728cea70b4cb246e47ce0d53fd6f9ee1322ffac64f76d80b151dec9874c

-- 970_azure_browser_update_admission.sql sha256:f0c124700b9fd7d8d598b6314169df09ec58b81be9dfa59b5400c52ff75474c3

-- 971_private_action_channel_continuity.sql sha256:00217ef822cad398aaa83aad49690f636c86934993d658b8e1edd6dac2552a8a

-- 972_personal_agent_cloud_removal.sql sha256:5311f417dcf75a622e0942fc079d410fed86e8230048fab743f0bba5900ccf8b

BEGIN;
SET LOCAL search_path=pg_catalog,public;
-- PostgreSQL dump-style declaration order. SQL bodies are revalidated below
-- after every referenced final signature/table exists, before commit.
SET LOCAL check_function_bodies=off;

DO $pod_414$
BEGIN
 IF EXISTS(SELECT 1 FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace LEFT JOIN pg_attrdef d ON d.adrelid=c.oid AND d.adnum=a.attnum
 WHERE n.nspname='public' AND c.relname IN ('account_deletion_tombstones','agent_prompt_versions','byoc_setup_jobs','consent_audit','consent_audit_receipts','one_action_directive_ledger','personal_agent_cloud_removals','personal_agent_deletion_tombstones','personal_agent_registry','personal_agent_standby_placements','pod_lifecycle_events','pod_migration_jobs','pod_request_nonces','shared_files_storage','webauthn_challenges','webauthn_credentials') AND a.attnum>0 AND NOT a.attisdropped
 AND NOT EXISTS(SELECT 1 FROM (VALUES ('account_deletion_tombstones','user_id_hash','text',true,NULL,'',''),('account_deletion_tombstones','firebase_uid','text',false,NULL,'',''),('account_deletion_tombstones','cleanup_intent_kind','text',true,'''full_account''::text','',''),('account_deletion_tombstones','expected_phone_digest','text',false,NULL,'',''),('account_deletion_tombstones','cleanup_status','text',true,'''pending''::text','',''),('account_deletion_tombstones','cleanup_attempt_count','integer',true,'0','',''),('account_deletion_tombstones','cleanup_next_attempt_at','timestamp with time zone',false,NULL,'',''),('account_deletion_tombstones','cleanup_claimed_at','timestamp with time zone',false,NULL,'',''),('account_deletion_tombstones','cleanup_claim_token','uuid',false,NULL,'',''),('account_deletion_tombstones','cleanup_last_attempt_at','timestamp with time zone',false,NULL,'',''),('account_deletion_tombstones','cleanup_last_outcome','text',false,NULL,'',''),('account_deletion_tombstones','cleanup_last_failure_class','text',false,NULL,'',''),('account_deletion_tombstones','cleanup_last_classification','text',false,NULL,'',''),('account_deletion_tombstones','deleted_at','timestamp with time zone',true,'now()','',''),('account_deletion_tombstones','updated_at','timestamp with time zone',true,'now()','',''),('account_deletion_tombstones','erasure_phase','text',true,'''provider_cleanup''::text','',''),('account_deletion_tombstones','account_owner_id','text',false,NULL,'',''),('account_deletion_tombstones','firebase_identity_hash','text',false,NULL,'',''),('account_deletion_tombstones','provider_cleanup_requested_target','text',true,'''both''::text','',''),('account_deletion_tombstones','provider_cleanup_id','uuid',false,NULL,'',''),('account_deletion_tombstones','provider_cleanup_inventory','jsonb',true,'''{}''::jsonb','',''),('account_deletion_tombstones','provider_cleanup_receipt','jsonb',true,'''{}''::jsonb','',''),('account_deletion_tombstones','provider_cleanup_next_attempt_at','timestamp with time zone',false,NULL,'',''),('account_deletion_tombstones','generation_retired_at','timestamp with time zone',false,NULL,'',''),('agent_prompt_versions','id','bigint',true,'nextval(''agent_prompt_versions_id_seq''::regclass)','',''),('agent_prompt_versions','agent_id','text',true,NULL,'',''),('agent_prompt_versions','channel','text',true,'''default''::text','',''),('agent_prompt_versions','version','text',true,NULL,'',''),('agent_prompt_versions','prompt_text','text',true,NULL,'',''),('agent_prompt_versions','prompt_sha256','text',true,NULL,'',''),('agent_prompt_versions','status','text',true,'''canary''::text','',''),('agent_prompt_versions','canary_percent','integer',true,'0','',''),('agent_prompt_versions','created_at','timestamp with time zone',true,'now()','',''),('byoc_setup_jobs','user_id','text',true,NULL,'',''),('byoc_setup_jobs','job_id','text',true,NULL,'',''),('byoc_setup_jobs','project_id','text',true,NULL,'',''),('byoc_setup_jobs','status','text',true,'''running''::text','',''),('byoc_setup_jobs','stage','text',true,'''starting''::text','',''),('byoc_setup_jobs','stages','jsonb',true,'''[]''::jsonb','',''),('byoc_setup_jobs','authorization_attempts','jsonb',true,'''{}''::jsonb','',''),('byoc_setup_jobs','error_code','text',false,NULL,'',''),('byoc_setup_jobs','error_message','text',false,NULL,'',''),('byoc_setup_jobs','created_at','timestamp with time zone',true,'now()','',''),('byoc_setup_jobs','updated_at','timestamp with time zone',true,'now()','',''),('consent_audit','id','integer',true,'nextval(''consent_audit_id_seq''::regclass)','',''),('consent_audit','token_id','text',true,NULL,'',''),('consent_audit','user_id','text',true,NULL,'',''),('consent_audit','agent_id','text',true,NULL,'',''),('consent_audit','scope','text',true,NULL,'',''),('consent_audit','action','text',true,NULL,'',''),('consent_audit','issued_at','bigint',true,NULL,'',''),('consent_audit','expires_at','bigint',false,NULL,'',''),('consent_audit','revoked_at','bigint',false,NULL,'',''),('consent_audit','metadata','jsonb',false,'''{}''::jsonb','',''),('consent_audit','token_type','character varying(20)',false,'''consent''::character varying','',''),('consent_audit','ip_address','character varying(45)',false,NULL,'',''),('consent_audit','user_agent','text',false,NULL,'',''),('consent_audit','request_id','text',false,NULL,'',''),('consent_audit','scope_description','text',false,NULL,'',''),('consent_audit','poll_timeout_at','bigint',false,NULL,'',''),('consent_audit_receipts','id','bigint',true,'nextval(''consent_audit_receipts_id_seq''::regclass)','',''),('consent_audit_receipts','subject_id','text',true,NULL,'',''),('consent_audit_receipts','seq','bigint',true,NULL,'',''),('consent_audit_receipts','event_type','text',true,NULL,'',''),('consent_audit_receipts','agent_id','text',false,NULL,'',''),('consent_audit_receipts','scope','text',false,NULL,'',''),('consent_audit_receipts','request_id','text',false,NULL,'',''),('consent_audit_receipts','token_id','text',false,NULL,'',''),('consent_audit_receipts','audit_event_id','bigint',false,NULL,'',''),('consent_audit_receipts','issued_at_ms','bigint',true,NULL,'',''),('consent_audit_receipts','metadata','jsonb',true,'''{}''::jsonb','',''),('consent_audit_receipts','prev_hash','text',true,NULL,'',''),('consent_audit_receipts','hash','text',true,NULL,'',''),('consent_audit_receipts','signature','text',true,NULL,'',''),('consent_audit_receipts','created_at','timestamp with time zone',true,'now()','',''),('consent_audit_receipts','ledger','text',true,'''consent''::text','',''),('one_action_directive_ledger','directive_id','text',true,NULL,'',''),('one_action_directive_ledger','schema_version','text',true,'''action.directive.v1''::text','',''),('one_action_directive_ledger','user_id','text',true,NULL,'',''),('one_action_directive_ledger','channel','text',true,NULL,'',''),('one_action_directive_ledger','conversation_id','uuid',false,NULL,'',''),('one_action_directive_ledger','session_id','text',false,NULL,'',''),('one_action_directive_ledger','action_id','text',true,NULL,'',''),('one_action_directive_ledger','context_revision','text',true,NULL,'',''),('one_action_directive_ledger','action_contract_digest','text',true,NULL,'',''),('one_action_directive_ledger','slots_hmac','text',true,NULL,'',''),('one_action_directive_ledger','resource_binding_hmac','text',false,NULL,'',''),('one_action_directive_ledger','requires_confirmation','boolean',true,'true','',''),('one_action_directive_ledger','trusted_activation_required','boolean',true,'false','',''),('one_action_directive_ledger','state','text',true,'''issued''::text','',''),('one_action_directive_ledger','receipt_hash','text',false,NULL,'',''),('one_action_directive_ledger','settlement_status','text',false,NULL,'',''),('one_action_directive_ledger','settlement_reason_code','text',false,NULL,'',''),('one_action_directive_ledger','issued_at','timestamp with time zone',true,'now()','',''),('one_action_directive_ledger','expires_at','timestamp with time zone',true,NULL,'',''),('one_action_directive_ledger','confirmed_at','timestamp with time zone',false,NULL,'',''),('one_action_directive_ledger','consumed_at','timestamp with time zone',false,NULL,'',''),('one_action_directive_ledger','settled_at','timestamp with time zone',false,NULL,'',''),('one_action_directive_ledger','command_effect','text',true,'''action''::text','',''),('one_action_directive_ledger','step_hmac','text',false,NULL,'',''),('one_action_directive_ledger','command_step','integer',false,NULL,'',''),('one_action_directive_ledger','operation_id','text',false,NULL,'',''),('one_action_directive_ledger','execution_receipt_hash','text',false,NULL,'',''),('one_action_directive_ledger','workflow_run_id','text',false,NULL,'',''),('one_action_directive_ledger','result_resource_kind','text',false,NULL,'',''),('one_action_directive_ledger','result_resource_id','uuid',false,NULL,'',''),('one_action_directive_ledger','membership_plan','jsonb',true,'''{}''::jsonb','',''),('one_action_directive_ledger','membership_receipts','jsonb',true,'''{}''::jsonb','',''),('one_action_directive_ledger','effect_request_hmac','text',false,NULL,'',''),('one_action_directive_ledger','effect_receipt','jsonb',false,NULL,'',''),('one_action_directive_ledger','audience_plan','jsonb',true,'''{}''::jsonb','',''),('one_action_directive_ledger','audience_receipts','jsonb',true,'''{}''::jsonb','',''),('one_action_directive_ledger','document_request_id','uuid',false,NULL,'',''),('one_action_directive_ledger','document_request_revision','bigint',false,NULL,'',''),('one_action_directive_ledger','adk_app_name','text',false,NULL,'',''),('personal_agent_cloud_removals','user_id','text',true,NULL,'',''),('personal_agent_cloud_removals','attempt_id','text',true,NULL,'',''),('personal_agent_cloud_removals','placement_epoch','bigint',true,NULL,'',''),('personal_agent_cloud_removals','snapshot_sha256','text',true,NULL,'',''),('personal_agent_cloud_removals','approved_digest','text',false,NULL,'',''),('personal_agent_cloud_removals','approved_at','timestamp with time zone',false,NULL,'',''),('personal_agent_cloud_removals','completed_at','timestamp with time zone',false,NULL,'',''),('personal_agent_cloud_removals','archive','jsonb',false,NULL,'',''),('personal_agent_cloud_removals','released_identity','jsonb',false,NULL,'',''),('personal_agent_cloud_removals','created_at','timestamp with time zone',true,'clock_timestamp()','',''),('personal_agent_cloud_removals','execution_started_at','timestamp with time zone',false,NULL,'',''),('personal_agent_cloud_removals','execution_digest','text',false,NULL,'',''),('personal_agent_cloud_removals','cancelled_at','timestamp with time zone',false,NULL,'',''),('personal_agent_deletion_tombstones','id','bigint',true,'nextval(''personal_agent_deletion_tombstones_id_seq''::regclass)','',''),('personal_agent_deletion_tombstones','hushh_id','text',true,NULL,'',''),('personal_agent_deletion_tombstones','external_agent_id','text',false,NULL,'',''),('personal_agent_deletion_tombstones','status','text',true,'''deprovision_requested''::text','',''),('personal_agent_deletion_tombstones','created_at','timestamp with time zone',true,'now()','',''),('personal_agent_deletion_tombstones','metadata','jsonb',false,NULL,'',''),('personal_agent_registry','user_id','text',true,NULL,'',''),('personal_agent_registry','hushh_id','text',true,NULL,'',''),('personal_agent_registry','hushh_id','text',false,NULL,'',''),('personal_agent_registry','phone_e164_hash','text',false,NULL,'',''),('personal_agent_registry','space_id','text',false,NULL,'',''),('personal_agent_registry','backend','text',false,NULL,'',''),('personal_agent_registry','external_agent_id','text',false,NULL,'',''),('personal_agent_registry','a2a_route','text',false,NULL,'',''),('personal_agent_registry','backend_metadata','jsonb',false,NULL,'',''),('personal_agent_registry','attestation_ref','text',false,NULL,'',''),('personal_agent_registry','pod_pubkey','text',false,NULL,'',''),('personal_agent_registry','pod_key_id','text',false,NULL,'',''),('personal_agent_registry','pod_key_wrapping_alg','text',false,NULL,'',''),('personal_agent_registry','runtime_version','text',false,NULL,'',''),('personal_agent_registry','prompt_version','text',false,NULL,'',''),('personal_agent_registry','status','text',true,'''unprovisioned''::text','',''),('personal_agent_registry','region','text',false,NULL,'',''),('personal_agent_registry','provisioned_at','timestamp with time zone',false,NULL,'',''),('personal_agent_registry','created_at','timestamp with time zone',true,'now()','',''),('personal_agent_registry','updated_at','timestamp with time zone',true,'now()','',''),('personal_agent_registry','deployment_target','text',false,NULL,'',''),('personal_agent_registry','model_credential_mode','text',false,NULL,'',''),('personal_agent_registry','user_cloud_project','text',false,NULL,'',''),('personal_agent_registry','user_cloud_region','text',false,NULL,'',''),('personal_agent_registry','user_cloud_bootstrap_sa','text',false,NULL,'',''),('personal_agent_registry','user_cloud_authorized_at','timestamp with time zone',false,NULL,'',''),('personal_agent_registry','last_heartbeat_at','timestamp with time zone',false,NULL,'',''),('personal_agent_registry','health_state','text',true,'''unknown''::text','',''),('personal_agent_registry','liveness_mode','text',true,'''warm''::text','',''),('personal_agent_registry','last_probe_at','timestamp with time zone',false,NULL,'',''),('personal_agent_registry','liveness_failures','integer',true,'0','',''),('personal_agent_registry','last_healed_at','timestamp with time zone',false,NULL,'',''),('personal_agent_registry','billing_space_id','text',false,NULL,'',''),('personal_agent_registry','pod_signing_pubkey','text',false,NULL,'',''),('personal_agent_registry','pod_signing_key_id','text',false,NULL,'',''),('personal_agent_registry','identity_mode','text',false,NULL,'',''),('personal_agent_registry','user_cloud_tenant_id','text',false,NULL,'',''),('personal_agent_registry','user_cloud_subscription_id','text',false,NULL,'',''),('personal_agent_registry','user_cloud_resource_group','text',false,NULL,'',''),('personal_agent_registry','placement_epoch','bigint',true,'0','',''),('personal_agent_standby_placements','user_id','text',true,NULL,'',''),('personal_agent_standby_placements','hushh_id','text',true,NULL,'',''),('personal_agent_standby_placements','deployment_target','text',true,NULL,'',''),('personal_agent_standby_placements','backend','text',false,NULL,'',''),('personal_agent_standby_placements','external_agent_id','text',true,NULL,'',''),('personal_agent_standby_placements','region','text',false,NULL,'',''),('personal_agent_standby_placements','model_credential_mode','text',false,NULL,'',''),('personal_agent_standby_placements','user_cloud_project','text',false,NULL,'',''),('personal_agent_standby_placements','user_cloud_region','text',false,NULL,'',''),('personal_agent_standby_placements','user_cloud_bootstrap_sa','text',false,NULL,'',''),('personal_agent_standby_placements','user_cloud_authorized_at','timestamp with time zone',false,NULL,'',''),('personal_agent_standby_placements','user_cloud_tenant_id','text',false,NULL,'',''),('personal_agent_standby_placements','user_cloud_subscription_id','text',false,NULL,'',''),('personal_agent_standby_placements','user_cloud_resource_group','text',false,NULL,'',''),('personal_agent_standby_placements','url','text',true,NULL,'',''),('personal_agent_standby_placements','pod_pubkey','text',true,NULL,'',''),('personal_agent_standby_placements','pod_key_id','text',true,NULL,'',''),('personal_agent_standby_placements','pod_key_wrapping_alg','text',false,NULL,'',''),('personal_agent_standby_placements','pod_signing_pubkey','text',true,NULL,'',''),('personal_agent_standby_placements','pod_signing_key_id','text',true,NULL,'',''),('personal_agent_standby_placements','runtime_version','text',false,NULL,'',''),('personal_agent_standby_placements','prompt_version','text',false,NULL,'',''),('personal_agent_standby_placements','backend_metadata','jsonb',true,'''{}''::jsonb','',''),('personal_agent_standby_placements','provisioned_at','timestamp with time zone',true,'now()','',''),('personal_agent_standby_placements','synced_seq','bigint',true,'0','',''),('personal_agent_standby_placements','synced_head_sha','text',false,NULL,'',''),('personal_agent_standby_placements','last_sync_at','timestamp with time zone',false,NULL,'',''),('personal_agent_standby_placements','last_sync_attempt_at','timestamp with time zone',false,NULL,'',''),('personal_agent_standby_placements','last_sync_status','text',true,'''pending''::text','',''),('personal_agent_standby_placements','sync_lease_id','text',false,NULL,'',''),('personal_agent_standby_placements','sync_lease_at','timestamp with time zone',false,NULL,'',''),('personal_agent_standby_placements','created_at','timestamp with time zone',true,'now()','',''),('personal_agent_standby_placements','updated_at','timestamp with time zone',true,'now()','',''),('pod_lifecycle_events','user_id','text',true,NULL,'',''),('pod_lifecycle_events','seq','bigint',true,NULL,'',''),('pod_lifecycle_events','hushh_id','text',false,NULL,'',''),('pod_lifecycle_events','attempt','integer',true,'1','',''),('pod_lifecycle_events','event','text',true,NULL,'',''),('pod_lifecycle_events','stage','text',true,NULL,'',''),('pod_lifecycle_events','registry_status','text',true,NULL,'',''),('pod_lifecycle_events','progress_pct','smallint',true,'0','',''),('pod_lifecycle_events','substrate_step','text',false,NULL,'',''),('pod_lifecycle_events','step_ok','boolean',false,NULL,'',''),('pod_lifecycle_events','terminal','boolean',true,'false','',''),('pod_lifecycle_events','reason','text',false,NULL,'',''),('pod_lifecycle_events','occurred_at','timestamp with time zone',true,'now()','',''),('pod_lifecycle_events','expires_at','timestamp with time zone',true,'(now() + ''30 days''::interval)','',''),('pod_migration_jobs','user_id','text',true,NULL,'',''),('pod_migration_jobs','job_id','text',true,NULL,'',''),('pod_migration_jobs','hushh_id','text',true,NULL,'',''),('pod_migration_jobs','target_project','text',true,NULL,'',''),('pod_migration_jobs','target_region','text',false,NULL,'',''),('pod_migration_jobs','source_pod_url','text',false,NULL,'',''),('pod_migration_jobs','source_service','text',false,NULL,'',''),('pod_migration_jobs','status','text',true,'''running''::text','',''),('pod_migration_jobs','stage','text',true,'''starting''::text','',''),('pod_migration_jobs','stages','jsonb',true,'''[]''::jsonb','',''),('pod_migration_jobs','source_head_sha','text',false,NULL,'',''),('pod_migration_jobs','source_record_count','integer',false,NULL,'',''),('pod_migration_jobs','target_head_sha','text',false,NULL,'',''),('pod_migration_jobs','target_record_count','integer',false,NULL,'',''),('pod_migration_jobs','error_code','text',false,NULL,'',''),('pod_migration_jobs','error_message','text',false,NULL,'',''),('pod_migration_jobs','created_at','timestamp with time zone',true,'now()','',''),('pod_migration_jobs','updated_at','timestamp with time zone',true,'now()','',''),('pod_request_nonces','kid','text',true,NULL,'',''),('pod_request_nonces','nonce','text',true,NULL,'',''),('pod_request_nonces','expires_at','timestamp with time zone',true,NULL,'',''),('shared_files_storage','user_id','text',true,NULL,'',''),('shared_files_storage','library_id','uuid',true,'gen_random_uuid()','',''),('shared_files_storage','bucket','text',true,NULL,'',''),('shared_files_storage','prefix','text',true,NULL,'',''),('shared_files_storage','bucket_admission','jsonb',false,NULL,'',''),('shared_files_storage','state','text',true,'''active''::text','',''),('shared_files_storage','lease_id','uuid',false,NULL,'',''),('shared_files_storage','lease_until','timestamp with time zone',false,NULL,'',''),('shared_files_storage','writes','jsonb',true,'''{}''::jsonb','',''),('shared_files_storage','receipt','jsonb',false,NULL,'',''),('shared_files_storage','updated_at','timestamp with time zone',true,'now()','',''),('webauthn_challenges','id','bigint',true,'nextval(''webauthn_challenges_id_seq''::regclass)','',''),('webauthn_challenges','user_id','text',false,NULL,'',''),('webauthn_challenges','challenge','text',true,NULL,'',''),('webauthn_challenges','ceremony','text',true,NULL,'',''),('webauthn_challenges','rp_id','text',true,NULL,'',''),('webauthn_challenges','expires_at','timestamp with time zone',true,NULL,'',''),('webauthn_challenges','created_at','timestamp with time zone',true,'now()','',''),('webauthn_credentials','id','bigint',true,'nextval(''webauthn_credentials_id_seq''::regclass)','',''),('webauthn_credentials','user_id','text',true,NULL,'',''),('webauthn_credentials','credential_id','text',true,NULL,'',''),('webauthn_credentials','public_key','text',true,NULL,'',''),('webauthn_credentials','sign_count','bigint',true,'0','',''),('webauthn_credentials','aaguid','text',false,NULL,'',''),('webauthn_credentials','device_type','text',false,NULL,'',''),('webauthn_credentials','backed_up','boolean',false,NULL,'',''),('webauthn_credentials','rp_id','text',true,NULL,'',''),('webauthn_credentials','device_label','text',false,NULL,'',''),('webauthn_credentials','created_at','timestamp with time zone',true,'now()','',''),('webauthn_credentials','last_used_at','timestamp with time zone',false,NULL,'','')) AS expected(t,col,typ,nn,def,ident,gen) WHERE expected.t=c.relname AND expected.col=a.attname AND expected.typ=format_type(a.atttypid,a.atttypmod) AND expected.nn=a.attnotnull AND expected.def IS NOT DISTINCT FROM pg_get_expr(d.adbin,d.adrelid) AND expected.ident=a.attidentity::text AND expected.gen=a.attgenerated::text)) THEN
 RAISE EXCEPTION 'Unqualified private-agent column drift'; END IF;
END
$pod_414$;

DO $pod_414$
BEGIN
 IF EXISTS(SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid=k.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname IN ('account_deletion_tombstones','agent_prompt_versions','byoc_setup_jobs','consent_audit','consent_audit_receipts','one_action_directive_ledger','personal_agent_cloud_removals','personal_agent_deletion_tombstones','personal_agent_registry','personal_agent_standby_placements','pod_lifecycle_events','pod_migration_jobs','pod_request_nonces','shared_files_storage','webauthn_challenges','webauthn_credentials') AND NOT EXISTS(SELECT 1 FROM (VALUES ('account_deletion_tombstones','account_deletion_tombstones_check','CHECK (cleanup_intent_kind = ''full_account''::text AND expected_phone_digest IS NULL OR cleanup_intent_kind = ''phone_orphan''::text AND (firebase_uid IS NULL AND expected_phone_digest IS NULL OR firebase_uid IS NOT NULL AND expected_phone_digest ~ ''^hmac-sha256:[0-9a-f]{64}$''::text))',true),('account_deletion_tombstones','account_deletion_tombstones_check1','CHECK (cleanup_status <> ''completed''::text OR firebase_uid IS NULL)',true),('account_deletion_tombstones','account_deletion_tombstones_check2','CHECK ((cleanup_status = ''running''::text) = (cleanup_claim_token IS NOT NULL))',true),('account_deletion_tombstones','account_deletion_tombstones_cleanup_attempt_count_check','CHECK (cleanup_attempt_count >= 0)',true),('account_deletion_tombstones','account_deletion_tombstones_cleanup_intent_kind_check','CHECK (cleanup_intent_kind = ANY (ARRAY[''full_account''::text, ''phone_orphan''::text]))',true),('account_deletion_tombstones','account_deletion_tombstones_cleanup_last_classification_check','CHECK (cleanup_last_classification IS NULL OR cleanup_last_classification ~ ''^[a-z0-9_]{1,120}$''::text)',true),('account_deletion_tombstones','account_deletion_tombstones_cleanup_last_failure_class_check','CHECK (cleanup_last_failure_class IS NULL OR char_length(cleanup_last_failure_class) <= 120)',true),('account_deletion_tombstones','account_deletion_tombstones_cleanup_status_check','CHECK (cleanup_status = ANY (ARRAY[''pending''::text, ''running''::text, ''quarantined''::text, ''retry_pending''::text, ''completed''::text]))',true),('account_deletion_tombstones','account_deletion_tombstones_firebase_uid_check','CHECK (firebase_uid IS NULL OR char_length(firebase_uid) >= 1 AND char_length(firebase_uid) <= 128)',true),('account_deletion_tombstones','account_deletion_tombstones_pkey','PRIMARY KEY (user_id_hash)',true),('account_deletion_tombstones','account_deletion_tombstones_provider_cleanup_requested_ta_check','CHECK (provider_cleanup_requested_target = ANY (ARRAY[''investor''::text, ''ria''::text, ''both''::text]))',true),('account_deletion_tombstones','account_deletion_tombstones_user_id_hash_check','CHECK (user_id_hash ~ ''^sha256:[0-9a-f]{64}$''::text)',true),('account_deletion_tombstones','account_erasure_phase_valid','CHECK (erasure_phase = ANY (ARRAY[''provider_cleanup''::text, ''local_erasure''::text, ''erased''::text]))',true),('account_deletion_tombstones','account_local_erasure_settlement','TRIGGER DEFERRABLE INITIALLY DEFERRED',true),('account_deletion_tombstones','account_provider_cleanup_authority_retained','CHECK (erasure_phase = ''erased''::text OR provider_cleanup_id IS NOT NULL AND firebase_uid IS NOT NULL AND account_owner_id IS NOT NULL)',true),('account_deletion_tombstones','account_provider_cleanup_inventory_bounded','CHECK (jsonb_typeof(provider_cleanup_inventory) = ''object''::text AND octet_length(provider_cleanup_inventory::text) <= 65536)',true),('account_deletion_tombstones','account_provider_cleanup_not_firebase','CHECK (erasure_phase = ''erased''::text OR cleanup_next_attempt_at IS NULL)',true),('account_deletion_tombstones','account_provider_cleanup_receipt_bounded','CHECK (jsonb_typeof(provider_cleanup_receipt) = ''object''::text AND octet_length(provider_cleanup_receipt::text) <= 262144)',true),('byoc_setup_jobs','byoc_setup_jobs_pkey','PRIMARY KEY (user_id)',true),('consent_audit','consent_audit_pkey','PRIMARY KEY (id)',true),('one_action_directive_ledger','adk_chat_action_identity','CHECK (channel = ''adk_chat''::text AND adk_app_name IS NOT NULL AND adk_app_name = ''hussh_one''::text AND requires_confirmation AND trusted_activation_required AND resource_binding_hmac IS NOT NULL OR channel <> ''adk_chat''::text AND adk_app_name IS NULL)',true),('one_action_directive_ledger','adk_chat_action_session_fk','FOREIGN KEY (adk_app_name, user_id, session_id) REFERENCES one_adk_sessions(app_name, user_id, session_id) ON DELETE CASCADE',true),('one_action_directive_ledger','command_identity_required','CHECK (channel <> ''command''::text OR command_step IS NOT NULL AND command_step >= 0 AND command_step < 12 AND operation_id IS NOT NULL)',true),('one_action_directive_ledger','document_review_identity_required','CHECK (channel <> ''document_review''::text AND document_request_id IS NULL AND document_request_revision IS NULL OR channel = ''document_review''::text AND document_request_id IS NOT NULL AND document_request_revision IS NOT NULL AND document_request_revision > 0 AND operation_id IS NOT NULL AND requires_confirmation AND trusted_activation_required AND action_contract_digest ~ ''^[0-9a-f]{64}$''::text AND slots_hmac ~ ''^[0-9a-f]{64}$''::text AND resource_binding_hmac IS NOT NULL AND resource_binding_hmac ~ ''^[0-9a-f]{64}$''::text AND command_step IS NULL AND step_hmac IS NULL AND command_effect = ''action''::text)',true),('one_action_directive_ledger','one_action_directive_ledger_channel_check','CHECK (channel = ANY (ARRAY[''typed_chat''::text, ''voice''::text, ''command''::text, ''document_review''::text, ''adk_chat''::text]))',true),('one_action_directive_ledger','one_action_directive_ledger_check','CHECK (channel = ''typed_chat''::text AND conversation_id IS NOT NULL AND session_id IS NULL OR (channel = ANY (ARRAY[''voice''::text, ''command''::text, ''adk_chat''::text])) AND session_id IS NOT NULL AND conversation_id IS NULL OR channel = ''document_review''::text AND conversation_id IS NULL AND session_id IS NULL)',true),('one_action_directive_ledger','one_action_directive_ledger_command_effect_check','CHECK (command_effect = ANY (ARRAY[''action''::text, ''screen''::text, ''workflow''::text]))',true),('one_action_directive_ledger','one_action_directive_ledger_conversation_id_fkey','FOREIGN KEY (conversation_id) REFERENCES agent_chat_conversations(id) ON DELETE CASCADE',true),('one_action_directive_ledger','one_action_directive_ledger_pkey','PRIMARY KEY (directive_id)',true),('one_action_directive_ledger','one_action_directive_ledger_receipt_hash_key','UNIQUE (receipt_hash)',true),('one_action_directive_ledger','one_action_directive_ledger_state_check','CHECK (state = ANY (ARRAY[''issued''::text, ''confirmed''::text, ''consumed''::text, ''settled''::text, ''cancelled''::text, ''expired''::text]))',true),('one_action_directive_ledger','one_command_audience_receipts_valid','CHECK (jsonb_typeof(audience_plan) = ''object''::text AND octet_length(audience_plan::text) <= 1000000 AND jsonb_typeof(audience_receipts) = ''object''::text AND octet_length(audience_receipts::text) <= 1000000 AND (audience_plan = ''{}''::jsonb AND audience_receipts = ''{}''::jsonb OR channel = ''command''::text AND (action_id = ANY (ARRAY[''location.share_selected''::text, ''location.send_request''::text, ''location.send_check_in''::text]))))',true),('one_action_directive_ledger','one_command_effect_receipt_shape','CHECK (effect_request_hmac IS NULL AND effect_receipt IS NULL OR channel = ''command''::text AND effect_request_hmac IS NOT NULL AND effect_request_hmac ~ ''^[a-f0-9]{64}$''::text AND (effect_receipt IS NULL OR jsonb_typeof(effect_receipt) = ''object''::text AND octet_length(effect_receipt::text) <= 4096))',true),('one_action_directive_ledger','one_command_membership_receipts_valid','CHECK (jsonb_typeof(membership_plan) = ''object''::text AND octet_length(membership_plan::text) <= 50000 AND (membership_plan = ''{}''::jsonb OR channel = ''command''::text AND action_id = ''location.add_to_circle''::text) AND jsonb_typeof(membership_receipts) = ''object''::text AND octet_length(membership_receipts::text) <= 1000000 AND (membership_receipts = ''{}''::jsonb OR channel = ''command''::text AND action_id = ''location.add_to_circle''::text))',true),('one_action_directive_ledger','one_command_resource_receipt_check','CHECK (result_resource_kind IS NULL AND result_resource_id IS NULL OR channel = ''command''::text AND command_effect = ''action''::text AND result_resource_kind = ''circle''::text AND result_resource_id IS NOT NULL)',true),('one_action_directive_ledger','one_command_workflow_binding_check','CHECK (workflow_run_id IS NULL OR channel = ''command''::text AND command_effect = ''workflow''::text AND workflow_run_id ~ ''^run_[a-z0-9]{16,96}$''::text)',true),('personal_agent_registry','personal_agent_registry_pkey','PRIMARY KEY (user_id)',true),('agent_prompt_versions','agent_prompt_versions_canary_pct_check','CHECK (canary_percent >= 0 AND canary_percent <= 100)',true),('agent_prompt_versions','agent_prompt_versions_pkey','PRIMARY KEY (id)',true),('agent_prompt_versions','agent_prompt_versions_status_check','CHECK (status = ANY (ARRAY[''active''::text, ''canary''::text, ''retired''::text]))',true),('consent_audit_receipts','consent_audit_receipts_pkey','PRIMARY KEY (id)',true),('consent_audit_receipts','consent_audit_receipts_subject_id_ledger_hash_key','UNIQUE (subject_id, ledger, hash)',true),('consent_audit_receipts','consent_audit_receipts_subject_id_ledger_seq_key','UNIQUE (subject_id, ledger, seq)',true),('one_action_directive_ledger','one_action_directive_ledger_channel_check','CHECK (channel = ANY (ARRAY[''typed_chat''::text, ''voice''::text, ''command''::text, ''document_review''::text, ''adk_chat''::text, ''pod_chat''::text]))',true),('one_action_directive_ledger','one_action_directive_ledger_check','CHECK (channel = ''typed_chat''::text AND conversation_id IS NOT NULL AND session_id IS NULL OR (channel = ANY (ARRAY[''voice''::text, ''command''::text, ''adk_chat''::text, ''pod_chat''::text])) AND session_id IS NOT NULL AND conversation_id IS NULL OR channel = ''document_review''::text AND conversation_id IS NULL AND session_id IS NULL)',true),('one_action_directive_ledger','pod_chat_action_identity','CHECK (channel <> ''pod_chat''::text OR adk_app_name IS NULL AND (action_id = ANY (ARRAY[''connector.mcp.invoke''::text, ''browser.model_process''::text, ''browser.disclose''::text, ''browser.session_remember''::text, ''browser.session_restore''::text, ''browser.provider_safety''::text])) AND requires_confirmation AND trusted_activation_required AND resource_binding_hmac IS NOT NULL)',true),('personal_agent_cloud_removals','personal_agent_cloud_removals_approved_digest_check','CHECK (approved_digest ~ ''^[0-9a-f]{64}$''::text)',true),('personal_agent_cloud_removals','personal_agent_cloud_removals_archive_check','CHECK (archive IS NULL OR jsonb_typeof(archive) = ''object''::text AND octet_length(archive::text) <= 2097152)',true),('personal_agent_cloud_removals','personal_agent_cloud_removals_check','CHECK ((approved_digest IS NULL) = (approved_at IS NULL))',true),('personal_agent_cloud_removals','personal_agent_cloud_removals_check1','CHECK ((completed_at IS NULL) = (archive IS NULL))',true),('personal_agent_cloud_removals','personal_agent_cloud_removals_check2','CHECK ((completed_at IS NULL) = (released_identity IS NULL))',true),('personal_agent_cloud_removals','personal_agent_cloud_removals_pkey','PRIMARY KEY (user_id, attempt_id)',true),('personal_agent_cloud_removals','personal_agent_cloud_removals_placement_epoch_check','CHECK (placement_epoch >= 0)',true),('personal_agent_cloud_removals','personal_agent_cloud_removals_snapshot_sha256_check','CHECK (snapshot_sha256 ~ ''^[0-9a-f]{64}$''::text)',true),('personal_agent_deletion_tombstones','personal_agent_deletion_tombstones_pkey','PRIMARY KEY (id)',true),('personal_agent_registry','personal_agent_registry_azure_ids_shape_check','CHECK ((user_cloud_tenant_id IS NULL OR user_cloud_tenant_id ~ ''^[0-9a-f]{8}-([0-9a-f]{4}-){3}[0-9a-f]{12}$''::text) AND (user_cloud_subscription_id IS NULL OR user_cloud_subscription_id ~ ''^[0-9a-f]{8}-([0-9a-f]{4}-){3}[0-9a-f]{12}$''::text))',true),('personal_agent_registry','personal_agent_registry_deployment_target_check','CHECK (deployment_target IS NULL OR (deployment_target = ANY (ARRAY[''gcp''::text, ''user_gcp''::text, ''user_azure''::text, ''null''::text])))',true),('personal_agent_registry','personal_agent_registry_health_state_check','CHECK (health_state = ANY (ARRAY[''unknown''::text, ''healthy''::text, ''degraded''::text, ''unreachable''::text, ''sleeping''::text]))',true),('personal_agent_registry','personal_agent_registry_identity_mode_check','CHECK (identity_mode IS NULL OR identity_mode = ''signed''::text)',true),('personal_agent_registry','personal_agent_registry_liveness_mode_check','CHECK (liveness_mode = ANY (ARRAY[''warm''::text, ''economy''::text]))',true),('personal_agent_registry','personal_agent_registry_model_credential_mode_check','CHECK (model_credential_mode IS NULL OR (model_credential_mode = ANY (ARRAY[''user_adc''::text, ''byok_per_turn''::text, ''fleet_adc''::text, ''user_azure_mi''::text])))',true),('personal_agent_registry','personal_agent_registry_placement_epoch_check','CHECK (placement_epoch >= 0)',true),('personal_agent_registry','personal_agent_registry_pod_signing_key_check','CHECK ((pod_signing_pubkey IS NULL) = (pod_signing_key_id IS NULL) AND (pod_signing_pubkey IS NULL OR pod_pubkey IS NOT NULL) AND (pod_signing_pubkey IS NULL OR pod_signing_pubkey ~ ''^[A-Za-z0-9+/]{43}=$''::text) AND (pod_signing_key_id IS NULL OR pod_signing_key_id ~ ''^pods_[0-9a-f]{32}$''::text))',true),('personal_agent_registry','personal_agent_registry_status_check','CHECK (status = ANY (ARRAY[''unprovisioned''::text, ''pending''::text, ''provisioning''::text, ''connecting''::text, ''provisioned''::text, ''provisioning_failed''::text, ''needs_reinit''::text, ''migrating''::text, ''reaped''::text, ''suspended''::text]))',true),('personal_agent_registry','personal_agent_registry_user_azure_needs_coordinates_check','CHECK (deployment_target IS DISTINCT FROM ''user_azure''::text OR user_cloud_tenant_id IS NOT NULL AND user_cloud_subscription_id IS NOT NULL AND user_cloud_resource_group IS NOT NULL AND user_cloud_region IS NOT NULL)',true),('personal_agent_registry','personal_agent_registry_user_gcp_needs_project_check','CHECK (deployment_target IS DISTINCT FROM ''user_gcp''::text OR user_cloud_project IS NOT NULL)',true),('personal_agent_registry','zz_personal_agent_notification_retention','TRIGGER DEFERRABLE INITIALLY DEFERRED',true),('personal_agent_standby_placements','personal_agent_standby_azure_ids_shape_check','CHECK ((user_cloud_tenant_id IS NULL OR user_cloud_tenant_id ~ ''^[0-9a-f]{8}-([0-9a-f]{4}-){3}[0-9a-f]{12}$''::text) AND (user_cloud_subscription_id IS NULL OR user_cloud_subscription_id ~ ''^[0-9a-f]{8}-([0-9a-f]{4}-){3}[0-9a-f]{12}$''::text))',true),('personal_agent_standby_placements','personal_agent_standby_lease_check','CHECK ((sync_lease_id IS NULL) = (sync_lease_at IS NULL) AND (sync_lease_id IS NULL OR sync_lease_id ~ ''^[0-9a-f]{32}$''::text))',true),('personal_agent_standby_placements','personal_agent_standby_metadata_check','CHECK (jsonb_typeof(backend_metadata) = ''object''::text AND NOT backend_metadata ?| ARRAY[''erasure''::text, ''upgradeLease''::text, ''detachedPlacements''::text, ''url''::text] AND (NOT backend_metadata ? ''provisionAttempt''::text OR ((backend_metadata -> ''provisionAttempt''::text) ->> ''phase''::text) = ''provisioned''::text))',true),('personal_agent_standby_placements','personal_agent_standby_model_mode_check','CHECK (model_credential_mode IS NULL OR (model_credential_mode = ANY (ARRAY[''user_adc''::text, ''byok_per_turn''::text, ''fleet_adc''::text, ''user_azure_mi''::text])))',true),('personal_agent_standby_placements','personal_agent_standby_placements_hushh_id_fkey','FOREIGN KEY (hushh_id) REFERENCES personal_agent_registry(hushh_id) ON DELETE RESTRICT',true),('personal_agent_standby_placements','personal_agent_standby_placements_pkey','PRIMARY KEY (user_id)',true),('personal_agent_standby_placements','personal_agent_standby_placements_user_id_fkey','FOREIGN KEY (user_id) REFERENCES personal_agent_registry(user_id) ON DELETE RESTRICT',true),('personal_agent_standby_placements','personal_agent_standby_signing_key_check','CHECK (pod_signing_pubkey ~ ''^[A-Za-z0-9+/]{43}=$''::text AND pod_signing_key_id ~ ''^pods_[0-9a-f]{32}$''::text)',true),('personal_agent_standby_placements','personal_agent_standby_sync_check','CHECK (synced_seq >= 0 AND (synced_seq = 0) = (synced_head_sha IS NULL) AND (synced_head_sha IS NULL OR synced_head_sha ~ ''^[0-9a-f]{64}$''::text) AND (last_sync_status = ANY (ARRAY[''pending''::text, ''synced''::text, ''failed''::text, ''diverged''::text])))',true),('personal_agent_standby_placements','personal_agent_standby_target_check','CHECK (deployment_target = ANY (ARRAY[''gcp''::text, ''user_gcp''::text, ''user_azure''::text]))',true),('personal_agent_standby_placements','personal_agent_standby_url_check','CHECK ("left"(url, 8) = ''https://''::text AND length(url) <= 2048)',true),('personal_agent_standby_placements','personal_agent_standby_user_azure_needs_coordinates_check','CHECK (deployment_target IS DISTINCT FROM ''user_azure''::text OR user_cloud_tenant_id IS NOT NULL AND user_cloud_subscription_id IS NOT NULL AND user_cloud_resource_group IS NOT NULL AND user_cloud_region IS NOT NULL)',true),('personal_agent_standby_placements','personal_agent_standby_user_gcp_needs_project_check','CHECK (deployment_target IS DISTINCT FROM ''user_gcp''::text OR user_cloud_project IS NOT NULL)',true),('personal_agent_standby_placements','zx_personal_agent_standby_placement','TRIGGER DEFERRABLE INITIALLY DEFERRED',true),('personal_agent_standby_placements','zz_personal_agent_notification_standby_retention','TRIGGER DEFERRABLE INITIALLY DEFERRED',true),('pod_lifecycle_events','pod_lifecycle_events_pkey','PRIMARY KEY (user_id, seq)',true),('pod_migration_jobs','pod_migration_jobs_pkey','PRIMARY KEY (user_id)',true),('pod_request_nonces','pod_request_nonces_kid_check','CHECK (kid ~ ''^pods_[0-9a-f]{32}$''::text)',true),('pod_request_nonces','pod_request_nonces_nonce_check','CHECK (nonce ~ ''^[A-Za-z0-9_-]{22}$''::text)',true),('pod_request_nonces','pod_request_nonces_pkey','PRIMARY KEY (kid, nonce)',true),('shared_files_storage','shared_files_storage_bucket_admission_check','CHECK (bucket_admission IS NULL OR jsonb_typeof(bucket_admission) = ''object''::text)',true),('shared_files_storage','shared_files_storage_pkey','PRIMARY KEY (user_id)',true),('shared_files_storage','shared_files_storage_state_check','CHECK (state = ANY (ARRAY[''active''::text, ''erasing''::text, ''erased''::text]))',true),('shared_files_storage','shared_files_storage_user_id_fkey','FOREIGN KEY (user_id) REFERENCES vault_keys(user_id) ON DELETE RESTRICT',true),('shared_files_storage','shared_files_storage_writes_check','CHECK (jsonb_typeof(writes) = ''object''::text)',true),('webauthn_challenges','webauthn_challenges_pkey','PRIMARY KEY (id)',true),('webauthn_credentials','webauthn_credentials_credential_id_key','UNIQUE (credential_id)',true),('webauthn_credentials','webauthn_credentials_pkey','PRIMARY KEY (id)',true),('personal_agent_cloud_removals','cloud_removal_cancel_inert','CHECK (cancelled_at IS NULL OR approved_digest IS NULL AND execution_started_at IS NULL AND completed_at IS NULL)',true),('personal_agent_cloud_removals','cloud_removal_dispatch_pair','CHECK ((execution_started_at IS NULL) = (execution_digest IS NULL))',true),('personal_agent_cloud_removals','personal_agent_cloud_removals_execution_digest_check','CHECK (execution_digest ~ ''^[0-9a-f]{64}$''::text)',true)) expected(t,name,definition,validated) WHERE expected.t=c.relname AND expected.name=k.conname AND expected.definition=pg_get_constraintdef(k.oid,true) AND expected.validated=k.convalidated)) THEN RAISE EXCEPTION 'Unqualified private-agent constraint drift'; END IF;
END
$pod_414$;

DO $pod_414$
BEGIN
 IF EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname IN ('account_deletion_tombstones','agent_prompt_versions','byoc_setup_jobs','consent_audit','consent_audit_receipts','one_action_directive_ledger','personal_agent_cloud_removals','personal_agent_deletion_tombstones','personal_agent_registry','personal_agent_standby_placements','pod_lifecycle_events','pod_migration_jobs','pod_request_nonces','shared_files_storage','webauthn_challenges','webauthn_credentials') AND c.relkind<>'r') THEN RAISE EXCEPTION 'Unqualified private-agent relation kind'; END IF;
END
$pod_414$;

DO $pod_414$
BEGIN
 IF EXISTS(SELECT 1 FROM (SELECT c.relname,t.tgname FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND NOT t.tgisinternal AND c.relname IN ('account_deletion_tombstones','agent_prompt_versions','byoc_setup_jobs','consent_audit','consent_audit_receipts','one_action_directive_ledger','personal_agent_cloud_removals','personal_agent_deletion_tombstones','personal_agent_registry','personal_agent_standby_placements','pod_lifecycle_events','pod_migration_jobs','pod_request_nonces','shared_files_storage','webauthn_challenges','webauthn_credentials')) actual(t,name) WHERE NOT EXISTS(SELECT 1 FROM (VALUES ('account_deletion_tombstones','account_cleanup_refresh_receipt'),('account_deletion_tombstones','account_generation_retirement'),('account_deletion_tombstones','account_generation_retirement_stamp'),('account_deletion_tombstones','account_local_erasure_settlement'),('account_deletion_tombstones','account_provider_cleanup_phase'),('account_deletion_tombstones','one_marketing_erasure'),('account_deletion_tombstones','push_account_erased'),('account_deletion_tombstones','zv_azure_vm_power'),('byoc_setup_jobs','account_retired_generation_update'),('byoc_setup_jobs','trg_reject_deleted_account_insert'),('byoc_setup_jobs','trg_reject_deleted_account_reference_update'),('byoc_setup_jobs','zv_azure_vm_power'),('byoc_setup_jobs','zw_byoc_azure_erasure'),('byoc_setup_jobs','zx_project_grant_setup'),('byoc_setup_jobs','zz_byoc_authorization_attempts'),('consent_audit','account_retired_generation_update'),('consent_audit','consent_audit_after_insert'),('consent_audit','consent_audit_feed_fanout'),('consent_audit','consent_audit_outcome_feed'),('consent_audit','live_memory_source_journal'),('consent_audit','trg_reject_deleted_account_insert'),('consent_audit','trg_reject_deleted_account_reference_update'),('consent_audit','zy_personal_agent_erasure_grant'),('consent_audit','zz_personal_agent_renewal_authority'),('consent_audit_receipts','account_retired_generation_update'),('consent_audit_receipts','trg_reject_deleted_account_insert'),('consent_audit_receipts','trg_reject_deleted_account_reference_update'),('one_action_directive_ledger','account_retired_generation_update'),('one_action_directive_ledger','one_action_directive_ledger_outcome_feed'),('one_action_directive_ledger','trg_reject_deleted_account_insert'),('one_action_directive_ledger','trg_reject_deleted_account_reference_update'),('personal_agent_cloud_removals','account_retired_generation_update'),('personal_agent_cloud_removals','trg_reject_deleted_account_insert'),('personal_agent_cloud_removals','trg_reject_deleted_account_reference_update'),('personal_agent_cloud_removals','zz_personal_agent_cloud_removal'),('personal_agent_cloud_removals','zz_personal_agent_cloud_removal_history'),('personal_agent_deletion_tombstones','zv_azure_vm_power'),('personal_agent_deletion_tombstones','zz_personal_agent_erasure_archive'),('personal_agent_registry','account_retired_generation_update'),('personal_agent_registry','trg_reject_deleted_account_insert'),('personal_agent_registry','trg_reject_deleted_account_reference_update'),('personal_agent_registry','zw_azure_vm_power'),('personal_agent_registry','zx_personal_agent_notification_registry'),('personal_agent_registry','zx_project_grant_registry'),('personal_agent_registry','zy_personal_agent_provision_registry'),('personal_agent_registry','zz_personal_agent_erasure_registry'),('personal_agent_registry','zz_personal_agent_notification_retention'),('personal_agent_registry','zzz_pod_signing_key_follows_pod_key'),('personal_agent_standby_placements','account_retired_generation_update'),('personal_agent_standby_placements','trg_reject_deleted_account_insert'),('personal_agent_standby_placements','trg_reject_deleted_account_reference_update'),('personal_agent_standby_placements','zw_azure_vm_power_standby'),('personal_agent_standby_placements','zx_personal_agent_standby_placement'),('personal_agent_standby_placements','zz_personal_agent_notification_standby_retention'),('pod_lifecycle_events','account_retired_generation_update'),('pod_lifecycle_events','pod_lifecycle_after_insert'),('pod_lifecycle_events','trg_reject_deleted_account_insert'),('pod_lifecycle_events','trg_reject_deleted_account_reference_update'),('pod_migration_jobs','account_retired_generation_update'),('pod_migration_jobs','trg_reject_deleted_account_insert'),('pod_migration_jobs','trg_reject_deleted_account_reference_update'),('pod_migration_jobs','zv_azure_vm_power'),('shared_files_storage','account_retired_generation_update'),('shared_files_storage','trg_reject_deleted_account_insert'),('shared_files_storage','trg_reject_deleted_account_reference_update'),('webauthn_challenges','account_retired_generation_update'),('webauthn_challenges','trg_reject_deleted_account_insert'),('webauthn_challenges','trg_reject_deleted_account_reference_update'),('webauthn_credentials','account_retired_generation_update'),('webauthn_credentials','trg_reject_deleted_account_insert'),('webauthn_credentials','trg_reject_deleted_account_reference_update')) expected(t,name) WHERE expected.t=actual.t AND expected.name=actual.name)) THEN RAISE EXCEPTION 'Unqualified private-agent triggers'; END IF;
END
$pod_414$;

DO $pod_414$
BEGIN
 IF EXISTS(SELECT 1 FROM (SELECT c.relname,i.relname FROM pg_index x JOIN pg_class c ON c.oid=x.indrelid JOIN pg_class i ON i.oid=x.indexrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND x.indisunique AND c.relname IN ('account_deletion_tombstones','agent_prompt_versions','byoc_setup_jobs','consent_audit','consent_audit_receipts','one_action_directive_ledger','personal_agent_cloud_removals','personal_agent_deletion_tombstones','personal_agent_registry','personal_agent_standby_placements','pod_lifecycle_events','pod_migration_jobs','pod_request_nonces','shared_files_storage','webauthn_challenges','webauthn_credentials') AND NOT EXISTS(SELECT 1 FROM pg_constraint k WHERE k.conindid=x.indexrelid AND k.contype IN ('p','u','x'))) actual(t,name) WHERE NOT EXISTS(SELECT 1 FROM (VALUES ('account_deletion_tombstones','account_cleanup_identity'),('account_deletion_tombstones','account_provider_cleanup_due'),('account_deletion_tombstones','idx_account_deletion_cleanup_due'),('agent_prompt_versions','idx_agent_prompt_versions_one_active'),('agent_prompt_versions','idx_agent_prompt_versions_unique'),('consent_audit','idx_consent_audit_created'),('consent_audit','idx_consent_audit_pending'),('consent_audit','idx_consent_audit_request_id'),('consent_audit','idx_consent_audit_user_action'),('consent_audit','idx_consent_token'),('consent_audit','idx_consent_user'),('consent_audit_receipts','idx_consent_audit_receipts_audit_event'),('consent_audit_receipts','idx_consent_audit_receipts_subject'),('one_action_directive_ledger','idx_one_action_directive_expiry'),('one_action_directive_ledger','idx_one_action_directive_user_conversation'),('one_action_directive_ledger','idx_one_action_directive_user_session'),('one_action_directive_ledger','one_command_operation_identity'),('one_action_directive_ledger','one_command_step_identity'),('one_action_directive_ledger','one_command_workflow_owner'),('one_action_directive_ledger','one_document_review_identity'),('personal_agent_deletion_tombstones','idx_personal_agent_tombstones_hushh_id'),('personal_agent_deletion_tombstones','idx_personal_agent_tombstones_status'),('personal_agent_deletion_tombstones','personal_agent_completed_erasure_owner'),('personal_agent_registry','idx_personal_agent_registry_billing_space_id'),('personal_agent_registry','idx_personal_agent_registry_health_state'),('personal_agent_registry','idx_personal_agent_registry_heartbeat'),('personal_agent_registry','idx_personal_agent_registry_hushh_id'),('personal_agent_registry','idx_personal_agent_registry_one_owner_per_azure_group'),('personal_agent_registry','idx_personal_agent_registry_one_owner_per_cloud'),('personal_agent_registry','idx_personal_agent_registry_status'),('personal_agent_registry','idx_personal_agent_registry_user_cloud_project'),('personal_agent_standby_placements','idx_personal_agent_standby_one_owner_per_azure_group'),('personal_agent_standby_placements','idx_personal_agent_standby_one_owner_per_cloud'),('personal_agent_standby_placements','idx_personal_agent_standby_sync_attempt'),('pod_lifecycle_events','idx_pod_lifecycle_expiry'),('pod_migration_jobs','idx_pod_migration_jobs_status_updated'),('pod_request_nonces','pod_request_nonces_expires_at_idx'),('webauthn_challenges','idx_webauthn_challenges_challenge'),('webauthn_challenges','idx_webauthn_challenges_expires'),('webauthn_credentials','idx_webauthn_credentials_user')) expected(t,name) WHERE expected.t=actual.t AND expected.name=actual.name)) THEN RAISE EXCEPTION 'Unqualified private-agent indexes'; END IF;
END
$pod_414$;

DO $pod_414$
BEGIN
 IF EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname IN ('approve_azure_erasure_plan','approve_personal_agent_cloud_removal','assert_azure_erasure_worker','assert_project_grant_admission','azure_account_cleanup_ready','azure_browser_update_admission_ready','azure_cleanup_candidate_digest','azure_cleanup_cloud_purpose_authorized','azure_cleanup_information_erased','azure_erasure_absence_settled','azure_erasure_authorization','azure_erasure_context','azure_erasure_execution_receipt','azure_erasure_request_retryable','azure_erasure_resources_complete','azure_erasure_setup_history','azure_erasure_writers_drained','azure_files_upgrade_admission_ready','azure_setup_never_deployed','azure_setup_no_effects','azure_setup_predeployment_proven','azure_vm_image_publication_proven','azure_vm_power_binding','azure_vm_power_eligible','azure_vm_power_pending','azure_vm_power_phase_proven','azure_vm_upgrade_dispatch_settled','azure_vm_upgrade_recovery_intent','azure_vm_upgrade_registry_binding','begin_azure_erasure_worker','begin_byoc_azure_worker','begin_byoc_azure_worker','block_unattempted_azure_vm_upgrade','browser_update_admission_ready','byoc_azure_files_request_admitted','byoc_azure_intent_admitted','byoc_azure_live_worker_admitted','byoc_azure_setup_guards_ready','byoc_azure_vm_upgrade_admitted','byoc_azure_vm_upgrade_request_ready','byoc_azure_worker_admitted','byoc_azure_worker_history_has_capacity','byoc_azure_worker_session_held','claim_personal_agent_provision','effective_erasure_azure_files_inventory','effective_erasure_substrate_inventory','erasure_mail_resource_state','erasure_mail_resources_deleted','erasure_never_hosted_admitted','erasure_planned_resources_covered','erasure_provider_revocation_complete','erasure_runtime_grants_complete','expected_erasure_bootstrap_release','expected_erasure_never_hosted','files_upgrade_admission_ready','finalize_personal_agent_cloud_removal','finalize_personal_agent_erasure','guard_azure_vm_power_deletion','guard_azure_vm_power_registry','guard_azure_vm_power_standby','guard_byoc_authorization_attempts','guard_byoc_azure_erasure_job','guard_personal_agent_cloud_removal','guard_personal_agent_cloud_removal_history','guard_personal_agent_erasure_archive','guard_personal_agent_erasure_grant','guard_personal_agent_erasure_registry','guard_personal_agent_notification_registry','guard_personal_agent_notification_retention','guard_personal_agent_notification_standby_retention','guard_personal_agent_provision_registry','guard_personal_agent_renewal','guard_personal_agent_standby_placement','guard_project_grant_registry_admission','guard_project_grant_setup_admission','insert_personal_agent_renewal','notification_checkpoint_admission_ready','notification_checkpoint_inventory','notification_erasure_custody_archived','notification_initial_host_binding','notification_placement_custody','operator_mail_grants_qualified','operator_notification_custody_ready','operator_topic_custody_preserved','personal_agent_cloud_removal_covers','personal_agent_cloud_removal_execute_ready','personal_agent_cloud_removal_identity','personal_agent_cloud_removal_ready','personal_agent_cloud_removal_replay_current','personal_agent_cloud_removal_review','personal_agent_cloud_removed','personal_agent_erasure_archive','personal_agent_erasure_archived','personal_agent_erasure_complete','pod_lifecycle_notify','project_grant_release_is_exclusive','publish_personal_agent_notification_checkpoint','publish_personal_agent_provision','reserve_azure_account_cleanup','reserve_erasure_bootstrap_grants','reserve_erasure_grant_release','reserve_personal_agent_cloud_removal','reserve_personal_agent_erasure','restore_personal_agent_erasure_reservation','retain_azure_cleanup_authorization_outcome','retain_azure_erasure_execution_receipt','retain_azure_erasure_state','retain_byoc_authorization','retain_byoc_azure_setup_intent','retain_byoc_azure_worker_event','retain_erasure_account_receipt','retain_erasure_bootstrap_grant_receipt','retain_erasure_bucket_receipt','retain_erasure_compute_receipt','retain_erasure_files_receipt','retain_erasure_files_upgrade_observation','retain_erasure_kms_receipt','retain_erasure_mail_receipt','retain_erasure_memory_binding','retain_erasure_memory_deletion','retain_erasure_never_hosted','retain_erasure_owner_access','retain_erasure_owner_access_checkpoint','retain_erasure_repository_grant_receipt','retain_erasure_repository_inventory','retain_erasure_repository_retention','retain_erasure_runtime_grant_receipt','retain_erasure_secret_receipt','retain_erasure_substrate_inventory','retain_erasure_upgrade_ack','retain_erasure_writer_receipt','retain_personal_agent_provision_ack','retire_superseded_pod_signing_key','valid_azure_arm_acknowledgement','valid_azure_browser_update_approval','valid_azure_cleanup_authorization_append','valid_azure_erasure_append','valid_azure_erasure_plan','valid_azure_retention_receipt','valid_azure_vm_power_event','valid_byoc_azure_hosted_intent','valid_byoc_azure_hosted_request','valid_byoc_azure_setup_intent','valid_byoc_azure_vm_upgrade_intent','valid_byoc_azure_worker_event','valid_erasure_account_append','valid_erasure_account_receipt','valid_erasure_azure_files_upgrade_observation','valid_erasure_bootstrap_append','valid_erasure_bucket_append','valid_erasure_bucket_receipt','valid_erasure_compute_append','valid_erasure_compute_receipt','valid_erasure_files_append','valid_erasure_files_receipt','valid_erasure_files_upgrade_observation','valid_erasure_gcp_files_upgrade_observation','valid_erasure_grant_release','valid_erasure_kms_append','valid_erasure_kms_receipt','valid_erasure_mail_append','valid_erasure_mail_receipt','valid_erasure_memory_binding','valid_erasure_memory_deletion','valid_erasure_never_hosted_append','valid_erasure_notification_observation','valid_erasure_owner_access','valid_erasure_owner_access_checkpoint','valid_erasure_provision_ack','valid_erasure_repository_grant_append','valid_erasure_repository_grant_receipt','valid_erasure_repository_inventory','valid_erasure_repository_retention','valid_erasure_runtime_grant_append','valid_erasure_runtime_grant_receipt','valid_erasure_secret_append','valid_erasure_secret_receipt','valid_erasure_substrate_inventory','valid_erasure_upgrade_ack','valid_erasure_writer_append','valid_erasure_writer_receipt','valid_gcp_browser_update_approval','valid_personal_agent_notification_checkpoint','valid_pod_upgrade_cursor','verify_erasure_account_preflight','verify_erasure_bucket_preflight','verify_erasure_files_preflight','verify_erasure_kms_preflight','verify_erasure_mail_preflight','verify_erasure_owner_access_preflight','verify_erasure_secret_preflight') AND NOT EXISTS(SELECT 1 FROM (VALUES ('approve_azure_erasure_plan','owner_id text, attempt_id text, expected_digest text, group_confirmation text'),('approve_personal_agent_cloud_removal','owner_id text, attempt text, expected_digest text, confirmation text'),('assert_azure_erasure_worker','owner_id text, attempt_id text, execution_id text'),('assert_project_grant_admission','project_id text'),('azure_account_cleanup_ready',''),('azure_browser_update_admission_ready',''),('azure_cleanup_candidate_digest','snapshot jsonb'),('azure_cleanup_cloud_purpose_authorized','owner_id text, attempt text'),('azure_cleanup_information_erased','owner_id text, reservation jsonb'),('azure_erasure_absence_settled','resource jsonb'),('azure_erasure_authorization','owner_id text, purpose text'),('azure_erasure_context','owner_id text'),('azure_erasure_execution_receipt','state jsonb, stage text, outcome text'),('azure_erasure_request_retryable','resource jsonb'),('azure_erasure_resources_complete','owner_id text, r jsonb'),('azure_erasure_setup_history','owner_id text'),('azure_erasure_writers_drained','owner_id text'),('azure_files_upgrade_admission_ready',''),('azure_setup_never_deployed','owner_id text, snapshot jsonb'),('azure_setup_no_effects','owner_id text'),('azure_setup_predeployment_proven','owner_id text, snapshot jsonb, require_resources boolean'),('azure_vm_image_publication_proven','prior personal_agent_registry, incoming personal_agent_registry'),('azure_vm_power_binding','agent jsonb'),('azure_vm_power_eligible','agent jsonb'),('azure_vm_power_pending','metadata jsonb'),('azure_vm_power_phase_proven','state jsonb, phase text'),('azure_vm_upgrade_dispatch_settled','intent jsonb, history jsonb'),('azure_vm_upgrade_recovery_intent','agent personal_agent_registry'),('azure_vm_upgrade_registry_binding','agent jsonb'),('begin_azure_erasure_worker','owner_id text, attempt_id text, execution_id text'),('begin_byoc_azure_worker','owner_id text, expected_job text, execution_id text'),('begin_byoc_azure_worker','owner_id text, expected_job text, execution_id text, intent jsonb'),('block_unattempted_azure_vm_upgrade','owner_id text, job_id text, operation_id text, attempt_id text, expected_binding jsonb'),('browser_update_admission_ready',''),('byoc_azure_files_request_admitted','owner_id text, event jsonb'),('byoc_azure_intent_admitted','agent personal_agent_registry, job byoc_setup_jobs, intent jsonb, allow_unbound boolean'),('byoc_azure_live_worker_admitted','owner_id text, expected_job text, allow_unbound boolean'),('byoc_azure_setup_guards_ready',''),('byoc_azure_vm_upgrade_admitted','agent personal_agent_registry, job byoc_setup_jobs, intent jsonb'),('byoc_azure_vm_upgrade_request_ready','intent jsonb, event jsonb, history jsonb'),('byoc_azure_worker_admitted','owner_id text, expected_job text'),('byoc_azure_worker_history_has_capacity','history jsonb'),('byoc_azure_worker_session_held','owner_id text'),('claim_personal_agent_provision','owner_id text, attempt_id text, observed jsonb, desired jsonb'),('effective_erasure_azure_files_inventory','r jsonb'),('effective_erasure_substrate_inventory','r jsonb'),('erasure_mail_resource_state','r jsonb, kind text, resource_id text'),('erasure_mail_resources_deleted','r jsonb'),('erasure_never_hosted_admitted','owner_id text, r jsonb'),('erasure_planned_resources_covered','r jsonb'),('erasure_provider_revocation_complete','reservation jsonb'),('erasure_runtime_grants_complete','r jsonb'),('expected_erasure_bootstrap_release','owner_id text, r jsonb, recovery_member text'),('expected_erasure_never_hosted','owner_id text, r jsonb'),('files_upgrade_admission_ready',''),('finalize_personal_agent_cloud_removal','owner_id text, attempt text, expected_digest text'),('finalize_personal_agent_erasure','owner_id text'),('guard_azure_vm_power_deletion',''),('guard_azure_vm_power_registry',''),('guard_azure_vm_power_standby',''),('guard_byoc_authorization_attempts',''),('guard_byoc_azure_erasure_job',''),('guard_personal_agent_cloud_removal',''),('guard_personal_agent_cloud_removal_history',''),('guard_personal_agent_erasure_archive',''),('guard_personal_agent_erasure_grant',''),('guard_personal_agent_erasure_registry',''),('guard_personal_agent_notification_registry',''),('guard_personal_agent_notification_retention',''),('guard_personal_agent_notification_standby_retention',''),('guard_personal_agent_provision_registry',''),('guard_personal_agent_renewal',''),('guard_personal_agent_standby_placement',''),('guard_project_grant_registry_admission',''),('guard_project_grant_setup_admission',''),('insert_personal_agent_renewal','event jsonb'),('notification_checkpoint_admission_ready',''),('notification_checkpoint_inventory','inventory jsonb, checkpoint jsonb'),('notification_erasure_custody_archived','owner_id text, r jsonb, placement jsonb'),('notification_initial_host_binding','previous jsonb, candidate jsonb'),('notification_placement_custody','placement jsonb'),('operator_mail_grants_qualified','r jsonb, resource_id text'),('operator_notification_custody_ready',''),('operator_topic_custody_preserved','before_meta jsonb, after_meta jsonb'),('personal_agent_cloud_removal_covers','owner_id text, placement jsonb'),('personal_agent_cloud_removal_execute_ready','owner_id text, attempt text'),('personal_agent_cloud_removal_identity','agent jsonb, removed_at timestamp with time zone, attempt text'),('personal_agent_cloud_removal_ready',''),('personal_agent_cloud_removal_replay_current','owner_id text, attempt text'),('personal_agent_cloud_removal_review','r jsonb'),('personal_agent_cloud_removed','owner_id text'),('personal_agent_erasure_archive','r jsonb, history jsonb'),('personal_agent_erasure_archived','owner_id text, r jsonb, history jsonb'),('personal_agent_erasure_complete','owner_id text'),('pod_lifecycle_notify',''),('project_grant_release_is_exclusive','owner_id text, target_project text'),('publish_personal_agent_notification_checkpoint','owner_id text, operation_kind text, attempt_id text, operation_id text, expected_generation bigint, checkpoint jsonb'),('publish_personal_agent_provision','owner_id text, attempt_id text, expected_phase text, next_phase text, evidence jsonb'),('reserve_azure_account_cleanup','owner_id text, expected_snapshot_sha256 text'),('reserve_erasure_bootstrap_grants','owner_id text, attempt_id text, expected jsonb, recovery_member text'),('reserve_erasure_grant_release','owner_id text, attempt_id text, expected jsonb'),('reserve_personal_agent_cloud_removal','owner_id text, expected_snapshot text'),('reserve_personal_agent_erasure','owner_id text, attempt_id text'),('restore_personal_agent_erasure_reservation','owner_id text, attempt_id text, snapshot_sha256 text, evidence jsonb'),('retain_azure_cleanup_authorization_outcome','owner_id text, attempt_id text, nonce_sha256 text, purpose text, auth_digest text, outcome text, code text'),('retain_azure_erasure_execution_receipt','owner_id text, attempt_id text, execution_id text, stage text, outcome text, observed_ids jsonb'),('retain_azure_erasure_state','owner_id text, attempt_id text, expected jsonb, next_state jsonb'),('retain_byoc_authorization','owner_id text, target_job text, intent jsonb, receipt jsonb'),('retain_byoc_azure_setup_intent','owner_id text, expected_job text, intent jsonb'),('retain_byoc_azure_worker_event','owner_id text, expected_job text, event jsonb'),('retain_erasure_account_receipt','owner_id text, attempt_id text, expected jsonb, stage text, receipt jsonb'),('retain_erasure_bootstrap_grant_receipt','owner_id text, attempt_id text, expected jsonb, grant_key text, stage text, receipt jsonb'),('retain_erasure_bucket_receipt','owner_id text, attempt_id text, expected jsonb, stage text, receipt jsonb'),('retain_erasure_compute_receipt','owner_id text, attempt_id text, expected jsonb, stage text, receipt jsonb'),('retain_erasure_files_receipt','owner_id text, attempt_id text, expected jsonb, kind text, stage text, receipt jsonb'),('retain_erasure_files_upgrade_observation','owner_id text, lease text, observation jsonb'),('retain_erasure_kms_receipt','owner_id text, attempt_id text, expected jsonb, stage text, receipt jsonb'),('retain_erasure_mail_receipt','owner_id text, attempt_id text, expected jsonb, kind text, stage text, receipt jsonb'),('retain_erasure_memory_binding','owner_id text, attempt_id text, expected jsonb, receipt jsonb'),('retain_erasure_memory_deletion','owner_id text, attempt_id text, expected jsonb, receipt jsonb'),('retain_erasure_never_hosted','owner_id text, attempt_id text, expected jsonb'),('retain_erasure_owner_access','owner_id text, attempt_id text, expected jsonb, receipt jsonb'),('retain_erasure_owner_access_checkpoint','owner_id text, attempt_id text, expected jsonb, checkpoint jsonb'),('retain_erasure_repository_grant_receipt','owner_id text, attempt_id text, expected jsonb, stage text, receipt jsonb'),('retain_erasure_repository_inventory','owner_id text, attempt_id text, expected jsonb, receipt jsonb'),('retain_erasure_repository_retention','owner_id text, attempt_id text, expected jsonb, receipt jsonb'),('retain_erasure_runtime_grant_receipt','owner_id text, attempt_id text, expected jsonb, stage text, receipt jsonb'),('retain_erasure_secret_receipt','owner_id text, attempt_id text, expected jsonb, stage text, receipt jsonb'),('retain_erasure_substrate_inventory','owner_id text, attempt_id text, expected jsonb'),('retain_erasure_upgrade_ack','owner_id text, lease text, receipt jsonb'),('retain_erasure_writer_receipt','owner_id text, attempt_id text, expected jsonb, stage text, receipt jsonb'),('retain_personal_agent_provision_ack','owner_id text, receipt jsonb'),('retire_superseded_pod_signing_key',''),('valid_azure_arm_acknowledgement','receipt jsonb, target text'),('valid_azure_browser_update_approval','agent jsonb, approval jsonb'),('valid_azure_cleanup_authorization_append','owner_id text, before_state jsonb, next_state jsonb'),('valid_azure_erasure_append','owner_id text, prior jsonb, incoming jsonb'),('valid_azure_erasure_plan','owner_id text, plan jsonb'),('valid_azure_retention_receipt','plan jsonb, resource_id text, receipt jsonb'),('valid_azure_vm_power_event','state jsonb, event jsonb'),('valid_byoc_azure_hosted_intent','owner_id text, job_id text, target text, hushh_id text, intent jsonb'),('valid_byoc_azure_hosted_request','intent jsonb, call jsonb, target text'),('valid_byoc_azure_setup_intent','owner_id text, job_id text, target text, hushh_id text, intent jsonb'),('valid_byoc_azure_vm_upgrade_intent','owner_id text, job_id text, target text, hushh_id text, intent jsonb'),('valid_byoc_azure_worker_event','owner_id text, expected_job text, event jsonb, history jsonb, target text, hushh_id text'),('valid_erasure_account_append','old_r jsonb, new_r jsonb'),('valid_erasure_account_receipt','r jsonb, stage text, receipt jsonb'),('valid_erasure_azure_files_upgrade_observation','r jsonb, observation jsonb'),('valid_erasure_bootstrap_append','old_r jsonb, new_r jsonb'),('valid_erasure_bucket_append','before_record jsonb, after_record jsonb'),('valid_erasure_bucket_receipt','reservation jsonb, stage text, receipt jsonb'),('valid_erasure_compute_append','previous jsonb, candidate jsonb'),('valid_erasure_compute_receipt','reservation jsonb, stage text, receipt jsonb'),('valid_erasure_files_append','before_record jsonb, after_record jsonb'),('valid_erasure_files_receipt','r jsonb, kind text, stage text, receipt jsonb'),('valid_erasure_files_upgrade_observation','r jsonb, observation jsonb'),('valid_erasure_gcp_files_upgrade_observation','r jsonb, observation jsonb'),('valid_erasure_grant_release','r jsonb, receipt jsonb'),('valid_erasure_kms_append','old_r jsonb, new_r jsonb'),('valid_erasure_kms_receipt','r jsonb, stage text, receipt jsonb'),('valid_erasure_mail_append','before_record jsonb, after_record jsonb'),('valid_erasure_mail_receipt','reservation jsonb, kind text, stage text, receipt jsonb'),('valid_erasure_memory_binding','reservation jsonb, receipt jsonb'),('valid_erasure_memory_deletion','reservation jsonb, receipt jsonb'),('valid_erasure_never_hosted_append','owner_id text, old_r jsonb, new_r jsonb'),('valid_erasure_notification_observation','reservation jsonb, observation jsonb'),('valid_erasure_owner_access','reservation jsonb, receipt jsonb'),('valid_erasure_owner_access_checkpoint','reservation jsonb, checkpoint jsonb'),('valid_erasure_provision_ack','reservation jsonb, receipt jsonb'),('valid_erasure_repository_grant_append','old_r jsonb, new_r jsonb'),('valid_erasure_repository_grant_receipt','r jsonb, stage text, receipt jsonb'),('valid_erasure_repository_inventory','r jsonb, receipt jsonb'),('valid_erasure_repository_retention','r jsonb, receipt jsonb'),('valid_erasure_runtime_grant_append','old_r jsonb, new_r jsonb'),('valid_erasure_runtime_grant_receipt','r jsonb, stage text, receipt jsonb'),('valid_erasure_secret_append','old_r jsonb, new_r jsonb'),('valid_erasure_secret_receipt','r jsonb, stage text, receipt jsonb'),('valid_erasure_substrate_inventory','reservation jsonb, inventory jsonb'),('valid_erasure_upgrade_ack','reservation jsonb, receipt jsonb'),('valid_erasure_writer_append','before_record jsonb, after_record jsonb'),('valid_erasure_writer_receipt','reservation jsonb, stage text, receipt jsonb'),('valid_gcp_browser_update_approval','agent jsonb, approval jsonb'),('valid_personal_agent_notification_checkpoint','snapshot jsonb, checkpoint jsonb, previous jsonb'),('valid_pod_upgrade_cursor','cursor_value jsonb'),('verify_erasure_account_preflight','owner_id text, attempt_id text, expected jsonb'),('verify_erasure_bucket_preflight','owner_id text, attempt_id text, expected jsonb'),('verify_erasure_files_preflight','owner_id text, attempt_id text, expected jsonb'),('verify_erasure_kms_preflight','owner_id text, attempt_id text, expected jsonb'),('verify_erasure_mail_preflight','owner_id text, attempt_id text, expected jsonb'),('verify_erasure_owner_access_preflight','owner_id text, attempt_id text, expected jsonb'),('verify_erasure_secret_preflight','owner_id text, attempt_id text, expected jsonb')) expected(name,args) WHERE expected.name=p.proname AND expected.args=pg_get_function_identity_arguments(p.oid))) THEN RAISE EXCEPTION 'Unqualified private-agent function overload'; END IF;
END
$pod_414$;

CREATE SEQUENCE IF NOT EXISTS public."agent_prompt_versions_id_seq" AS bigint INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1 NO CYCLE;

DO $pod_414$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_sequence s JOIN pg_class c ON s.seqrelid=c.oid WHERE c.oid='public.agent_prompt_versions_id_seq'::regclass AND format_type(s.seqtypid,NULL)='bigint' AND s.seqincrement=1 AND s.seqmin=1 AND s.seqmax=9223372036854775807 AND s.seqcache=1 AND s.seqcycle=false) THEN RAISE EXCEPTION 'Unqualified sequence: agent_prompt_versions_id_seq'; END IF;
END
$pod_414$;

CREATE SEQUENCE IF NOT EXISTS public."consent_audit_receipts_id_seq" AS bigint INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1 NO CYCLE;

DO $pod_414$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_sequence s JOIN pg_class c ON s.seqrelid=c.oid WHERE c.oid='public.consent_audit_receipts_id_seq'::regclass AND format_type(s.seqtypid,NULL)='bigint' AND s.seqincrement=1 AND s.seqmin=1 AND s.seqmax=9223372036854775807 AND s.seqcache=1 AND s.seqcycle=false) THEN RAISE EXCEPTION 'Unqualified sequence: consent_audit_receipts_id_seq'; END IF;
END
$pod_414$;

CREATE SEQUENCE IF NOT EXISTS public."personal_agent_deletion_tombstones_id_seq" AS bigint INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1 NO CYCLE;

DO $pod_414$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_sequence s JOIN pg_class c ON s.seqrelid=c.oid WHERE c.oid='public.personal_agent_deletion_tombstones_id_seq'::regclass AND format_type(s.seqtypid,NULL)='bigint' AND s.seqincrement=1 AND s.seqmin=1 AND s.seqmax=9223372036854775807 AND s.seqcache=1 AND s.seqcycle=false) THEN RAISE EXCEPTION 'Unqualified sequence: personal_agent_deletion_tombstones_id_seq'; END IF;
END
$pod_414$;

CREATE SEQUENCE IF NOT EXISTS public."webauthn_challenges_id_seq" AS bigint INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1 NO CYCLE;

DO $pod_414$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_sequence s JOIN pg_class c ON s.seqrelid=c.oid WHERE c.oid='public.webauthn_challenges_id_seq'::regclass AND format_type(s.seqtypid,NULL)='bigint' AND s.seqincrement=1 AND s.seqmin=1 AND s.seqmax=9223372036854775807 AND s.seqcache=1 AND s.seqcycle=false) THEN RAISE EXCEPTION 'Unqualified sequence: webauthn_challenges_id_seq'; END IF;
END
$pod_414$;

CREATE SEQUENCE IF NOT EXISTS public."webauthn_credentials_id_seq" AS bigint INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1 NO CYCLE;

DO $pod_414$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_sequence s JOIN pg_class c ON s.seqrelid=c.oid WHERE c.oid='public.webauthn_credentials_id_seq'::regclass AND format_type(s.seqtypid,NULL)='bigint' AND s.seqincrement=1 AND s.seqmin=1 AND s.seqmax=9223372036854775807 AND s.seqcache=1 AND s.seqcycle=false) THEN RAISE EXCEPTION 'Unqualified sequence: webauthn_credentials_id_seq'; END IF;
END
$pod_414$;

CREATE TABLE IF NOT EXISTS public."agent_prompt_versions" (
 "id" bigint DEFAULT nextval('agent_prompt_versions_id_seq'::regclass) NOT NULL,
 "agent_id" text NOT NULL,
 "channel" text DEFAULT 'default'::text NOT NULL,
 "version" text NOT NULL,
 "prompt_text" text NOT NULL,
 "prompt_sha256" text NOT NULL,
 "status" text DEFAULT 'canary'::text NOT NULL,
 "canary_percent" integer DEFAULT 0 NOT NULL,
 "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

REVOKE ALL ON public."agent_prompt_versions" FROM PUBLIC;

COMMENT ON TABLE public."agent_prompt_versions" IS 'Versioned agent prompts for runtime sync without redeploy. Flip status=active (or stage via canary_percent) to roll forward/back. Phase 0.';

CREATE TABLE IF NOT EXISTS public."consent_audit_receipts" (
 "id" bigint DEFAULT nextval('consent_audit_receipts_id_seq'::regclass) NOT NULL,
 "subject_id" text NOT NULL,
 "seq" bigint NOT NULL,
 "event_type" text NOT NULL,
 "agent_id" text,
 "scope" text,
 "request_id" text,
 "token_id" text,
 "audit_event_id" bigint,
 "issued_at_ms" bigint NOT NULL,
 "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
 "prev_hash" text NOT NULL,
 "hash" text NOT NULL,
 "signature" text NOT NULL,
 "created_at" timestamp with time zone DEFAULT now() NOT NULL,
 "ledger" text DEFAULT 'consent'::text NOT NULL
);

REVOKE ALL ON public."consent_audit_receipts" FROM PUBLIC;

COMMENT ON TABLE public."consent_audit_receipts" IS 'Tamper-evident consent-audit receipt chain (NIST 800-53 AU-9/AU-10). Append-only, per (subject_id, ledger): hash = sha256(prev_hash || canonical payload), signature = Ed25519 under CONSENT_AUDIT_ED25519_PRIVATE_KEY -- deliberately NOT the token-minting APP_SIGNING_KEY, so an auditor can verify with the public key while holding nothing that could write. ledger is consent (person-visible permissions) or internal (the agent own operations). Stores metadata + hashes only, never secrets.';

CREATE TABLE IF NOT EXISTS public."personal_agent_cloud_removals" (
 "user_id" text NOT NULL,
 "attempt_id" text NOT NULL,
 "placement_epoch" bigint NOT NULL,
 "snapshot_sha256" text NOT NULL,
 "approved_digest" text,
 "approved_at" timestamp with time zone,
 "completed_at" timestamp with time zone,
 "archive" jsonb,
 "released_identity" jsonb,
 "created_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL
);

ALTER TABLE public."personal_agent_cloud_removals" ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public."personal_agent_cloud_removals" FROM PUBLIC;

COMMENT ON TABLE public."personal_agent_cloud_removals" IS 'Cloud-only owner approval and qualified resource-erasure proof. Deleted in the full account transaction; never authorizes account erasure or unrelated resource deletion.';

CREATE TABLE IF NOT EXISTS public."personal_agent_deletion_tombstones" (
 "id" bigint DEFAULT nextval('personal_agent_deletion_tombstones_id_seq'::regclass) NOT NULL,
 "hushh_id" text NOT NULL,
 "external_agent_id" text,
 "status" text DEFAULT 'deprovision_requested'::text NOT NULL,
 "created_at" timestamp with time zone DEFAULT now() NOT NULL,
 "metadata" jsonb
);

REVOKE ALL ON public."personal_agent_deletion_tombstones" FROM PUBLIC;

CREATE TABLE IF NOT EXISTS public."personal_agent_standby_placements" (
 "user_id" text NOT NULL,
 "hushh_id" text NOT NULL,
 "deployment_target" text NOT NULL,
 "backend" text,
 "external_agent_id" text NOT NULL,
 "region" text,
 "model_credential_mode" text,
 "user_cloud_project" text,
 "user_cloud_region" text,
 "user_cloud_bootstrap_sa" text,
 "user_cloud_authorized_at" timestamp with time zone,
 "user_cloud_tenant_id" text,
 "user_cloud_subscription_id" text,
 "user_cloud_resource_group" text,
 "url" text NOT NULL,
 "pod_pubkey" text NOT NULL,
 "pod_key_id" text NOT NULL,
 "pod_key_wrapping_alg" text,
 "pod_signing_pubkey" text NOT NULL,
 "pod_signing_key_id" text NOT NULL,
 "runtime_version" text,
 "prompt_version" text,
 "backend_metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
 "provisioned_at" timestamp with time zone DEFAULT now() NOT NULL,
 "synced_seq" bigint DEFAULT 0 NOT NULL,
 "synced_head_sha" text,
 "last_sync_at" timestamp with time zone,
 "last_sync_attempt_at" timestamp with time zone,
 "last_sync_status" text DEFAULT 'pending'::text NOT NULL,
 "sync_lease_id" text,
 "sync_lease_at" timestamp with time zone,
 "created_at" timestamp with time zone DEFAULT now() NOT NULL,
 "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

REVOKE ALL ON public."personal_agent_standby_placements" FROM PUBLIC;

COMMENT ON TABLE public."personal_agent_standby_placements" IS 'At most one synced standby agent per person: placement coordinates, address, public keys and sync progress only. No private key, token or record content.';

CREATE TABLE IF NOT EXISTS public."pod_lifecycle_events" (
 "user_id" text NOT NULL,
 "seq" bigint NOT NULL,
 "hushh_id" text,
 "attempt" integer DEFAULT 1 NOT NULL,
 "event" text NOT NULL,
 "stage" text NOT NULL,
 "registry_status" text NOT NULL,
 "progress_pct" smallint DEFAULT 0 NOT NULL,
 "substrate_step" text,
 "step_ok" boolean,
 "terminal" boolean DEFAULT false NOT NULL,
 "reason" text,
 "occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
 "expires_at" timestamp with time zone DEFAULT (now() + '30 days'::interval) NOT NULL
);

REVOKE ALL ON public."pod_lifecycle_events" FROM PUBLIC;

COMMENT ON TABLE public."pod_lifecycle_events" IS 'Append-only provisioning narrative. The registry row is authority; this is replayable narrative and the stream cursor source. 30-day retention via expires_at.';

CREATE TABLE IF NOT EXISTS public."pod_migration_jobs" (
 "user_id" text NOT NULL,
 "job_id" text NOT NULL,
 "hushh_id" text NOT NULL,
 "target_project" text NOT NULL,
 "target_region" text,
 "source_pod_url" text,
 "source_service" text,
 "status" text DEFAULT 'running'::text NOT NULL,
 "stage" text DEFAULT 'starting'::text NOT NULL,
 "stages" jsonb DEFAULT '[]'::jsonb NOT NULL,
 "source_head_sha" text,
 "source_record_count" integer,
 "target_head_sha" text,
 "target_record_count" integer,
 "error_code" text,
 "error_message" text,
 "created_at" timestamp with time zone DEFAULT now() NOT NULL,
 "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

REVOKE ALL ON public."pod_migration_jobs" FROM PUBLIC;

CREATE TABLE IF NOT EXISTS public."pod_request_nonces" (
 "kid" text NOT NULL,
 "nonce" text NOT NULL,
 "expires_at" timestamp with time zone NOT NULL
);

REVOKE ALL ON public."pod_request_nonces" FROM PUBLIC;

COMMENT ON TABLE public."pod_request_nonces" IS 'Single-use (kid, nonce) markers for signed pod requests. No owner column; rows expire about 120 s after their signing time and are pruned by the verifier.';

CREATE TABLE IF NOT EXISTS public."shared_files_storage" (
 "user_id" text NOT NULL,
 "library_id" uuid DEFAULT gen_random_uuid() NOT NULL,
 "bucket" text NOT NULL,
 "prefix" text NOT NULL,
 "bucket_admission" jsonb,
 "state" text DEFAULT 'active'::text NOT NULL,
 "lease_id" uuid,
 "lease_until" timestamp with time zone,
 "writes" jsonb DEFAULT '{}'::jsonb NOT NULL,
 "receipt" jsonb,
 "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE public."shared_files_storage" ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public."shared_files_storage" FROM PUBLIC;

COMMENT ON TABLE public."shared_files_storage" IS 'Shared Files ciphertext resource inventory and write fencing. No plaintext content or keys.';

CREATE TABLE IF NOT EXISTS public."webauthn_challenges" (
 "id" bigint DEFAULT nextval('webauthn_challenges_id_seq'::regclass) NOT NULL,
 "user_id" text,
 "challenge" text NOT NULL,
 "ceremony" text NOT NULL,
 "rp_id" text NOT NULL,
 "expires_at" timestamp with time zone NOT NULL,
 "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

REVOKE ALL ON public."webauthn_challenges" FROM PUBLIC;

CREATE TABLE IF NOT EXISTS public."webauthn_credentials" (
 "id" bigint DEFAULT nextval('webauthn_credentials_id_seq'::regclass) NOT NULL,
 "user_id" text NOT NULL,
 "credential_id" text NOT NULL,
 "public_key" text NOT NULL,
 "sign_count" bigint DEFAULT 0 NOT NULL,
 "aaguid" text,
 "device_type" text,
 "backed_up" boolean,
 "rp_id" text NOT NULL,
 "device_label" text,
 "created_at" timestamp with time zone DEFAULT now() NOT NULL,
 "last_used_at" timestamp with time zone
);

REVOKE ALL ON public."webauthn_credentials" FROM PUBLIC;

COMMENT ON TABLE public."webauthn_credentials" IS 'Server-verified WebAuthn/FIDO2 credential public keys (passkeys + hardware keys). sign_count catches cloned authenticators; aaguid drives AAL/attestation policy. Gated by WEBAUTHN_ENABLED. M14.';

ALTER TABLE public."personal_agent_registry" ADD COLUMN IF NOT EXISTS "last_heartbeat_at" timestamp with time zone;

ALTER TABLE public."personal_agent_registry" ADD COLUMN IF NOT EXISTS "health_state" text DEFAULT 'unknown'::text NOT NULL;

ALTER TABLE public."personal_agent_registry" ADD COLUMN IF NOT EXISTS "liveness_mode" text DEFAULT 'warm'::text NOT NULL;

ALTER TABLE public."personal_agent_registry" ADD COLUMN IF NOT EXISTS "last_probe_at" timestamp with time zone;

ALTER TABLE public."personal_agent_registry" ADD COLUMN IF NOT EXISTS "liveness_failures" integer DEFAULT 0 NOT NULL;

ALTER TABLE public."personal_agent_registry" ADD COLUMN IF NOT EXISTS "last_healed_at" timestamp with time zone;

ALTER TABLE public."personal_agent_registry" ADD COLUMN IF NOT EXISTS "billing_space_id" text;

ALTER TABLE public."personal_agent_registry" ADD COLUMN IF NOT EXISTS "pod_signing_pubkey" text;

ALTER TABLE public."personal_agent_registry" ADD COLUMN IF NOT EXISTS "pod_signing_key_id" text;

ALTER TABLE public."personal_agent_registry" ADD COLUMN IF NOT EXISTS "identity_mode" text;

ALTER TABLE public."personal_agent_registry" ADD COLUMN IF NOT EXISTS "user_cloud_tenant_id" text;

ALTER TABLE public."personal_agent_registry" ADD COLUMN IF NOT EXISTS "user_cloud_subscription_id" text;

ALTER TABLE public."personal_agent_registry" ADD COLUMN IF NOT EXISTS "user_cloud_resource_group" text;

ALTER TABLE public."personal_agent_registry" ADD COLUMN IF NOT EXISTS "placement_epoch" bigint DEFAULT 0 NOT NULL;

DO $object_guard$
DECLARE actual text;
BEGIN
 SELECT definition INTO actual FROM (SELECT pg_get_functiondef(p.oid) definition FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='approve_azure_erasure_plan' AND pg_get_function_identity_arguments(p.oid)='owner_id text, attempt_id text, expected_digest text, group_confirmation text') observed;
 IF actual IS NULL THEN
  EXECUTE $object$CREATE OR REPLACE FUNCTION public.approve_azure_erasure_plan(owner_id text, attempt_id text, expected_digest text, group_confirmation text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE agent public.personal_agent_registry%ROWTYPE; r jsonb; state jsonb; approval jsonb;
 now_seconds bigint:=extract(epoch FROM statement_timestamp())::bigint;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended(owner_id,171));
 PERFORM pg_advisory_xact_lock(hashtextextended(owner_id,198));
 SELECT * INTO agent FROM public.personal_agent_registry WHERE user_id=owner_id FOR UPDATE;
 IF NOT FOUND THEN RETURN NULL; END IF;
 r:=agent.backend_metadata->'erasure'; state:=r->'azureTeardown';
 IF r->>'attemptId' IS DISTINCT FROM attempt_id OR public.valid_azure_erasure_plan(owner_id,state->'plan') IS NOT TRUE
 OR state->'plan'->>'termsVersion' IS DISTINCT FROM 'azure-exact-parent-retention-v2'
 OR group_confirmation IS DISTINCT FROM '/subscriptions/'||(state->'plan'->'context'->>'subscriptionId')||
    '/resourceGroups/'||(state->'plan'->'context'->>'resourceGroup')
 OR expected_digest IS DISTINCT FROM encode(sha256(convert_to((state->'plan')::text,'UTF8')),'hex') THEN RETURN NULL; END IF;
 approval:=state->'approvals'->-1;
 IF (approval->>'expiresAt')::bigint>now_seconds THEN RETURN approval; END IF;
 approval:=jsonb_build_object('ownerId',owner_id,'attemptId',attempt_id,'planDigest',expected_digest,
  'issuedAt',now_seconds,'expiresAt',now_seconds+600,'scope','exact_plan','groupConfirmation',group_confirmation);
 state:=jsonb_set(state,'{approvals}',(state->'approvals')||jsonb_build_array(approval));
 IF public.retain_azure_erasure_state(owner_id,attempt_id,r,state) IS NOT TRUE THEN RETURN NULL; END IF;
 RETURN approval;
END;
$function$
$object$;
 ELSIF encode(sha256(convert_to(actual,'UTF8')),'hex') NOT IN ('8f22aba51cadd5539ea812f8fef5473a667b62fe6b0dd122c467264dc28d8a71') THEN
  RAISE EXCEPTION 'Unqualified schema drift: approve_azure_erasure_plan';
 END IF;
END
$object_guard$;

REVOKE ALL ON FUNCTION public."approve_azure_erasure_plan"(text, text, text, text) FROM PUBLIC;

DO $pod_414$
BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN GRANT EXECUTE ON FUNCTION public."approve_azure_erasure_plan"(text, text, text, text) TO service_role; END IF;
END
$pod_414$;

DO $object_guard$
DECLARE actual text;
BEGIN
 SELECT definition INTO actual FROM (SELECT pg_get_functiondef(p.oid) definition FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='approve_personal_agent_cloud_removal' AND pg_get_function_identity_arguments(p.oid)='owner_id text, attempt text, expected_digest text, confirmation text') observed;
 IF actual IS NULL THEN
  EXECUTE $object$CREATE OR REPLACE FUNCTION public.approve_personal_agent_cloud_removal(owner_id text, attempt text, expected_digest text, confirmation text)
 RETURNS boolean
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE agent public.personal_agent_registry%ROWTYPE; r jsonb; review jsonb;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended(owner_id,171));
 PERFORM pg_advisory_xact_lock(hashtextextended(owner_id,198));
 SELECT * INTO agent FROM public.personal_agent_registry WHERE user_id=owner_id FOR UPDATE;
 r:=agent.backend_metadata->'erasure'; review:=public.personal_agent_cloud_removal_review(r);
 IF review IS NULL OR r->>'attemptId' IS DISTINCT FROM attempt
 OR NOT EXISTS(SELECT 1 FROM public.personal_agent_cloud_removals WHERE user_id=owner_id AND attempt_id=attempt AND completed_at IS NULL)
 OR expected_digest IS DISTINCT FROM encode(sha256(convert_to(review::text,'UTF8')),'hex') THEN RETURN false; END IF;
 IF review->'context'->>'subscriptionId' IS NOT NULL THEN
  IF public.approve_azure_erasure_plan(owner_id,attempt,expected_digest,confirmation) IS NULL THEN RETURN false; END IF;
 ELSIF confirmation IS DISTINCT FROM review->>'project' THEN RETURN false;
 END IF;
 UPDATE public.personal_agent_cloud_removals SET approved_digest=expected_digest,approved_at=clock_timestamp()
 WHERE user_id=owner_id AND attempt_id=attempt AND completed_at IS NULL;
 RETURN FOUND;
END;
$function$
$object$;
 ELSIF encode(sha256(convert_to(actual,'UTF8')),'hex') NOT IN ('ae18c30c29572319d068b2edac962dc4b3701c512418856d9e98c56cd1fe73f4') THEN
  RAISE EXCEPTION 'Unqualified schema drift: approve_personal_agent_cloud_removal';
 END IF;
END
$object_guard$;

REVOKE ALL ON FUNCTION public."approve_personal_agent_cloud_removal"(text, text, text, text) FROM PUBLIC;

DO $pod_414$
BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN GRANT EXECUTE ON FUNCTION public."approve_personal_agent_cloud_removal"(text, text, text, text) TO service_role; END IF;
END
$pod_414$;

DO $object_guard$
DECLARE actual text;
BEGIN
 SELECT definition INTO actual FROM (SELECT pg_get_functiondef(p.oid) definition FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='assert_azure_erasure_worker' AND pg_get_function_identity_arguments(p.oid)='owner_id text, attempt_id text, execution_id text') observed;
 IF actual IS NULL THEN
  EXECUTE $object$CREATE OR REPLACE FUNCTION public.assert_azure_erasure_worker(owner_id text, attempt_id text, execution_id text)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public'
AS $function$
DECLARE r jsonb; state jsonb; approval jsonb;
BEGIN
 SELECT backend_metadata->'erasure' INTO r FROM public.personal_agent_registry
 WHERE user_id=owner_id AND status='suspended';
 state:=r->'azureTeardown'; approval:=state->'approvals'->-1;
 RETURN r->>'attemptId'=attempt_id
 AND public.byoc_azure_worker_session_held(owner_id) IS TRUE
 AND public.azure_account_cleanup_ready() IS TRUE
 AND public.valid_azure_erasure_plan(owner_id,state->'plan') IS TRUE
 AND public.azure_erasure_writers_drained(owner_id) IS TRUE
 AND public.azure_cleanup_information_erased(owner_id,r) IS TRUE
 AND state->'worker'->>'executionId'=execution_id
 AND state->'worker'->'backendPid'=to_jsonb(pg_backend_pid())
 AND state->'worker'->'approvalIndex'=to_jsonb(jsonb_array_length(state->'approvals')-1)
 AND NOT (coalesce(state->'finalReadbacks','{}'::jsonb) ? execution_id)
 AND NOT (coalesce(state->'workerExits','{}'::jsonb) ? execution_id)
 AND (approval->>'expiresAt')::bigint>extract(epoch FROM statement_timestamp());
END;
$function$
$object$;
 ELSIF encode(sha256(convert_to(actual,'UTF8')),'hex') NOT IN ('50236d8a2298531f61f64ed63d1a4f2c2250e014facb59e1fe62712f31e7a2f8','e004bb11cfe892742f82a21ca9f5691cf1fd8c15c224db4b3c6677988dc4d326') THEN
  RAISE EXCEPTION 'Unqualified schema drift: assert_azure_erasure_worker';
 END IF;
END
$object_guard$;

REVOKE ALL ON FUNCTION public."assert_azure_erasure_worker"(text, text, text) FROM PUBLIC;

DO $pod_414$
BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN GRANT EXECUTE ON FUNCTION public."assert_azure_erasure_worker"(text, text, text) TO service_role; END IF;
END
$pod_414$;

DO $object_guard$
DECLARE actual text;
BEGIN
 SELECT definition INTO actual FROM (SELECT pg_get_functiondef(p.oid) definition FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='assert_project_grant_admission' AND pg_get_function_identity_arguments(p.oid)='project_id text') observed;
 IF actual IS NULL THEN
  EXECUTE $object$CREATE OR REPLACE FUNCTION public.assert_project_grant_admission(project_id text)
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
BEGIN
 IF project_id IS NULL OR project_id='' THEN RETURN; END IF;
 IF (project_id !~ '^[a-z][a-z0-9-]{4,61}[a-z0-9]$'
     AND project_id !~ '^/subscriptions/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/resourceGroups/[A-Za-z0-9_().-]{0,89}[A-Za-z0-9_()-]$')
 OR current_setting('transaction_isolation') <> 'read committed' THEN
  RAISE EXCEPTION 'project grant admission unavailable' USING ERRCODE='42501'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(project_id,205));
 IF EXISTS (SELECT 1 FROM public.personal_agent_registry r WHERE r.backend_metadata->'erasure'->'grantRelease'->>'project'=project_id) THEN
  RAISE EXCEPTION 'project grant release reserved' USING ERRCODE='42501'; END IF;
END;
$function$
$object$;
 ELSIF encode(sha256(convert_to(actual,'UTF8')),'hex') NOT IN ('7809762b1a8f4e0703ca6d070c89fdec1d2ac30e2cd33298628d2dced7c72182') THEN
  RAISE EXCEPTION 'Unqualified schema drift: assert_project_grant_admission';
 END IF;
END
$object_guard$;

REVOKE ALL ON FUNCTION public."assert_project_grant_admission"(text) FROM PUBLIC;

DO $pod_414$
BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN GRANT EXECUTE ON FUNCTION public."assert_project_grant_admission"(text) TO service_role; END IF;
END
$pod_414$;

DO $object_guard$
DECLARE actual text;
BEGIN
 SELECT definition INTO actual FROM (SELECT pg_get_functiondef(p.oid) definition FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='azure_account_cleanup_ready' AND pg_get_function_identity_arguments(p.oid)='') observed;
 IF actual IS NULL THEN
  EXECUTE $object$CREATE OR REPLACE FUNCTION public.azure_account_cleanup_ready()
 RETURNS boolean
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
 SELECT (to_regprocedure('public.azure_erasure_resources_complete(text,jsonb)') IS NOT NULL
 AND to_regprocedure('public.reserve_azure_account_cleanup(text,text)') IS NOT NULL
 AND (SELECT value->'receipts'->'azureCleanup'=probe->'azureTeardown'
  AND value->'receipts'->'agentCryptoErase'=probe->'agentCryptoErase'
  AND value->'receipts'->'ownerAccessErasure'=probe->'ownerAccessErasure'
  FROM (SELECT jsonb_build_object('azureTeardown',jsonb_build_object('probe',true),
    'agentCryptoErase',jsonb_build_object('probe',true),
    'ownerAccessErasure',jsonb_build_object('probe',true)) probe) fixture
  CROSS JOIN LATERAL (SELECT public.personal_agent_erasure_archive(probe,'{}'::jsonb) value) checked)
 AND NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='trg_block_account_deletion_during_release'
  AND tgrelid IN ('public.actor_profiles'::regclass,'public.vault_keys'::regclass)
  AND tgenabled IN ('O','A'))) IS TRUE;
$function$
$object$;
 ELSIF encode(sha256(convert_to(actual,'UTF8')),'hex') NOT IN ('6e18eee11ec2d286b24eba97088d801a6348dbee1207a316bdb36dc793e638f6') THEN
  RAISE EXCEPTION 'Unqualified schema drift: azure_account_cleanup_ready';
 END IF;
END
$object_guard$;

REVOKE ALL ON FUNCTION public."azure_account_cleanup_ready"() FROM PUBLIC;

DO $pod_414$
BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN GRANT EXECUTE ON FUNCTION public."azure_account_cleanup_ready"() TO service_role; END IF;
END
$pod_414$;

DO $object_guard$
DECLARE actual text;
BEGIN
 SELECT definition INTO actual FROM (SELECT pg_get_functiondef(p.oid) definition FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='azure_browser_update_admission_ready' AND pg_get_function_identity_arguments(p.oid)='') observed;
 IF actual IS NULL THEN
  EXECUTE $object$CREATE OR REPLACE FUNCTION public.azure_browser_update_admission_ready()
 RETURNS boolean
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
 SELECT public.byoc_azure_setup_guards_ready()
 AND position('valid_azure_browser_update_approval' IN pg_get_functiondef(
  'public.byoc_azure_intent_admitted(public.personal_agent_registry,public.byoc_setup_jobs,jsonb,boolean)'::regprocedure))>0;
$function$
$object$;
 ELSIF encode(sha256(convert_to(actual,'UTF8')),'hex') NOT IN ('6113e01b912f70eb7a22ed55cb1cf8f2844301b192417ccbfef4f7e26fae450f') THEN
  RAISE EXCEPTION 'Unqualified schema drift: azure_browser_update_admission_ready';
 END IF;
END
$object_guard$;

REVOKE ALL ON FUNCTION public."azure_browser_update_admission_ready"() FROM PUBLIC;

DO $pod_414$
BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN GRANT EXECUTE ON FUNCTION public."azure_browser_update_admission_ready"() TO service_role; END IF;
END
$pod_414$;

DO $object_guard$
DECLARE actual text;
BEGIN
 SELECT definition INTO actual FROM (SELECT pg_get_functiondef(p.oid) definition FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='azure_cleanup_candidate_digest' AND pg_get_function_identity_arguments(p.oid)='snapshot jsonb') observed;
 IF actual IS NULL THEN
  EXECUTE $object$CREATE OR REPLACE FUNCTION public.azure_cleanup_candidate_digest(snapshot jsonb)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public'
AS $function$
 SELECT encode(sha256(convert_to((snapshot-ARRAY['last_heartbeat_at','health_state','liveness_failures'])::text,'UTF8')),'hex');
$function$
$object$;
 ELSIF encode(sha256(convert_to(actual,'UTF8')),'hex') NOT IN ('d47b923e2762e12f98652a3b50a3d2d0b626810e0e9ce05bc0b69f0063c210c2') THEN
  RAISE EXCEPTION 'Unqualified schema drift: azure_cleanup_candidate_digest';
 END IF;
END
$object_guard$;

REVOKE ALL ON FUNCTION public."azure_cleanup_candidate_digest"(jsonb) FROM PUBLIC;

DO $pod_414$
BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN GRANT EXECUTE ON FUNCTION public."azure_cleanup_candidate_digest"(jsonb) TO service_role; END IF;
END
$pod_414$;

DO $object_guard$
DECLARE actual text;
BEGIN
 SELECT definition INTO actual FROM (SELECT pg_get_functiondef(p.oid) definition FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='azure_cleanup_cloud_purpose_authorized' AND pg_get_function_identity_arguments(p.oid)='owner_id text, attempt text') observed;
 IF actual IS NULL THEN
  EXECUTE $object$CREATE OR REPLACE FUNCTION public.azure_cleanup_cloud_purpose_authorized(owner_id text, attempt text)
 RETURNS boolean
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
 SELECT NOT EXISTS(SELECT 1 FROM public.personal_agent_cloud_removals WHERE user_id=owner_id AND attempt_id=attempt)
 OR public.personal_agent_cloud_removal_execute_ready(owner_id,attempt) IS TRUE;
$function$
$object$;
 ELSIF encode(sha256(convert_to(actual,'UTF8')),'hex') NOT IN ('5a63de179c9c6faa31eb20eeb6e9b423b25e05ecc6cd1bea1a551d2737e20b6c') THEN
  RAISE EXCEPTION 'Unqualified schema drift: azure_cleanup_cloud_purpose_authorized';
 END IF;
END
$object_guard$;

REVOKE ALL ON FUNCTION public."azure_cleanup_cloud_purpose_authorized"(text, text) FROM PUBLIC;

DO $pod_414$
BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN GRANT EXECUTE ON FUNCTION public."azure_cleanup_cloud_purpose_authorized"(text, text) TO service_role; END IF;
END
$pod_414$;

DO $object_guard$
DECLARE actual text;
BEGIN
 SELECT definition INTO actual FROM (SELECT pg_get_functiondef(p.oid) definition FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='azure_cleanup_information_erased' AND pg_get_function_identity_arguments(p.oid)='owner_id text, reservation jsonb') observed;
 IF actual IS NULL THEN
  EXECUTE $object$CREATE OR REPLACE FUNCTION public.azure_cleanup_information_erased(owner_id text, reservation jsonb)
 RETURNS boolean
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
 SELECT public.erasure_provider_revocation_complete(reservation) IS TRUE
 OR public.azure_setup_never_deployed(owner_id,reservation->'registrySnapshot') IS TRUE;
$function$
$object$;
 ELSIF encode(sha256(convert_to(actual,'UTF8')),'hex') NOT IN ('9d655e3d35dc85e6e01acf191abb3a17b1d9133d07d486ef1824801aef710d0d') THEN
  RAISE EXCEPTION 'Unqualified schema drift: azure_cleanup_information_erased';
 END IF;
END
$object_guard$;

REVOKE ALL ON FUNCTION public."azure_cleanup_information_erased"(text, jsonb) FROM PUBLIC;

DO $pod_414$
BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN GRANT EXECUTE ON FUNCTION public."azure_cleanup_information_erased"(text, jsonb) TO service_role; END IF;
END
$pod_414$;

DO $object_guard$
DECLARE actual text;
BEGIN
 SELECT definition INTO actual FROM (SELECT pg_get_functiondef(p.oid) definition FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='azure_erasure_absence_settled' AND pg_get_function_identity_arguments(p.oid)='resource jsonb') observed;
 IF actual IS NULL THEN
  EXECUTE $object$CREATE OR REPLACE FUNCTION public.azure_erasure_absence_settled(resource jsonb)
 RETURNS boolean
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public'
AS $function$
 SELECT NOT resource ? 'provider_request' OR public.azure_erasure_request_retryable(resource) IS TRUE
  OR coalesce(resource->'provider_terminal'->>'outcome'='succeeded' OR (
   resource->'provider_terminal'->>'outcome'='refused' AND resource->'provider_ack'->>'status'='404'),false);
$function$
$object$;
 ELSIF encode(sha256(convert_to(actual,'UTF8')),'hex') NOT IN ('61a4fceedf875d79d382e3028575c1a7a752f1fbe8ab1cfdcab56bf679e035ea') THEN
  RAISE EXCEPTION 'Unqualified schema drift: azure_erasure_absence_settled';
 END IF;
END
$object_guard$;

REVOKE ALL ON FUNCTION public."azure_erasure_absence_settled"(jsonb) FROM PUBLIC;

DO $pod_414$
BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN GRANT EXECUTE ON FUNCTION public."azure_erasure_absence_settled"(jsonb) TO service_role; END IF;
END
$pod_414$;

DO $object_guard$
DECLARE actual text;
BEGIN
 SELECT definition INTO actual FROM (SELECT pg_get_functiondef(p.oid) definition FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='azure_erasure_authorization' AND pg_get_function_identity_arguments(p.oid)='owner_id text, purpose text') observed;
 IF actual IS NULL THEN
  EXECUTE $object$CREATE OR REPLACE FUNCTION public.azure_erasure_authorization(owner_id text, purpose text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public'
AS $function$
DECLARE context jsonb:=public.azure_erasure_context(owner_id); state jsonb; value jsonb; approval jsonb;
BEGIN
 IF context IS NULL OR (purpose IN ('inspect','execute')) IS NOT TRUE THEN RETURN NULL; END IF;
 value:=jsonb_build_object('purpose',purpose,'context',context);
 IF purpose='execute' THEN
  IF public.azure_erasure_writers_drained(owner_id) IS NOT TRUE THEN RETURN NULL; END IF;
  SELECT backend_metadata->'erasure'->'azureTeardown' INTO state
  FROM public.personal_agent_registry WHERE user_id=owner_id AND status='suspended';
  approval:=state->'approvals'->-1;
  IF public.valid_azure_erasure_plan(owner_id,state->'plan') IS NOT TRUE
  OR ((approval->>'expiresAt')::bigint>extract(epoch FROM statement_timestamp())) IS NOT TRUE
  OR approval->>'ownerId' IS DISTINCT FROM owner_id
  OR approval->>'attemptId' IS DISTINCT FROM context->>'attemptId'
  OR approval->>'scope' IS DISTINCT FROM 'exact_plan'
  OR approval->>'planDigest' IS DISTINCT FROM encode(sha256(convert_to((state->'plan')::text,'UTF8')),'hex')
  THEN RETURN NULL; END IF;
  value:=value||jsonb_build_object('approval',approval);
 END IF;
 RETURN value||jsonb_build_object('digest',encode(sha256(convert_to(value::text,'UTF8')),'hex'));
END;
$function$
$object$;
 ELSIF encode(sha256(convert_to(actual,'UTF8')),'hex') NOT IN ('373fe0801bc30186f24cbe82830f1990b474edf38665803c7e8399f3cc1b9da5') THEN
  RAISE EXCEPTION 'Unqualified schema drift: azure_erasure_authorization';
 END IF;
END
$object_guard$;

REVOKE ALL ON FUNCTION public."azure_erasure_authorization"(text, text) FROM PUBLIC;

DO $pod_414$
BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN GRANT EXECUTE ON FUNCTION public."azure_erasure_authorization"(text, text) TO service_role; END IF;
END
$pod_414$;

DO $object_guard$
DECLARE actual text;
BEGIN
 SELECT definition INTO actual FROM (SELECT pg_get_functiondef(p.oid) definition FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='azure_erasure_context' AND pg_get_function_identity_arguments(p.oid)='owner_id text') observed;
 IF actual IS NULL THEN
  EXECUTE $object$CREATE OR REPLACE FUNCTION public.azure_erasure_context(owner_id text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public'
AS $function$
DECLARE agent public.personal_agent_registry%ROWTYPE; job public.byoc_setup_jobs%ROWTYPE;
 r jsonb; s jsonb; context jsonb; original jsonb; tenant_id text; subscription_id text;
 resource_group text; location text;
BEGIN
 SELECT * INTO agent FROM public.personal_agent_registry WHERE user_id=owner_id;
 IF NOT FOUND OR agent.status IS DISTINCT FROM 'suspended' THEN RETURN NULL; END IF;
 r:=agent.backend_metadata->'erasure'; s:=r->'registrySnapshot';
 IF r->>'ownerId' IS DISTINCT FROM owner_id OR s->>'user_id' IS DISTINCT FROM owner_id
 OR r->>'hushhId' IS DISTINCT FROM agent.hushh_id
 OR coalesce(r->>'attemptId','')=''
 OR r ?| ARRAY['lateUpgradeAcknowledgement','lateProvisionAcknowledgement']
 OR nullif(s->'backend_metadata'->>'upgradeLease','') IS NOT NULL
 OR EXISTS(SELECT 1 FROM public.pod_migration_jobs WHERE user_id=owner_id)
 OR EXISTS(SELECT 1 FROM public.personal_agent_standby_placements WHERE user_id=owner_id)
 THEN RETURN NULL; END IF;
 SELECT * INTO job FROM public.byoc_setup_jobs WHERE user_id=owner_id;
 IF NOT FOUND OR job.status NOT IN ('recorded','failed')
 OR jsonb_typeof(job.stages) IS DISTINCT FROM 'array'
 OR EXISTS(SELECT 1 FROM jsonb_array_elements(job.stages) x
   WHERE x->>'stage'='azure_worker_started' AND NOT EXISTS(
    SELECT 1 FROM jsonb_array_elements(job.stages) y
    WHERE y->>'stage'='azure_worker_exited' AND y->>'executionId'=x->>'executionId'))
 OR EXISTS(SELECT 1 FROM jsonb_array_elements(job.stages) x
   WHERE x->>'stage'='azure_provider_request' AND NOT EXISTS(
    SELECT 1 FROM jsonb_array_elements(job.stages) y
    WHERE y->>'stage'='azure_provider_terminal' AND y->>'requestId'=x->>'requestId'))
 THEN RETURN NULL; END IF;
 SELECT x->'intent' INTO original FROM jsonb_array_elements(job.stages) x
 WHERE x->>'stage' IN ('azure_setup_intent','azure_setup_prior_intent') LIMIT 1;
 IF original IS NOT NULL AND public.valid_byoc_azure_setup_intent(owner_id,original->>'jobId',
   job.project_id,agent.hushh_id,original) IS NOT TRUE THEN RETURN NULL; END IF;
 IF s->>'deployment_target' IS DISTINCT FROM 'user_azure'
 AND NOT (original IS NOT NULL AND nullif(s->>'backend','') IS NULL
   AND nullif(s->>'external_agent_id','') IS NULL) THEN RETURN NULL; END IF;
 tenant_id:=coalesce(nullif(s->>'user_cloud_tenant_id',''),original->>'tenantId');
 subscription_id:=coalesce(nullif(s->>'user_cloud_subscription_id',''),original->>'subscriptionId');
 resource_group:=coalesce(nullif(s->>'user_cloud_resource_group',''),original->>'resourceGroup');
 location:=coalesce(nullif(s->>'user_cloud_region',''),original->>'location');
 IF tenant_id IS NULL OR subscription_id IS NULL OR resource_group IS NULL OR location IS NULL
 OR job.project_id IS DISTINCT FROM '/subscriptions/'||subscription_id||'/resourceGroups/'||resource_group
 OR EXISTS(SELECT 1 FROM jsonb_array_elements(job.stages) x
   WHERE x->>'stage' IN ('azure_setup_intent','azure_setup_prior_intent') AND (
    public.valid_byoc_azure_setup_intent(owner_id,x->'intent'->>'jobId',job.project_id,
      agent.hushh_id,x->'intent') IS NOT TRUE
    OR x->'intent'->>'tenantId' IS DISTINCT FROM tenant_id
    OR x->'intent'->>'subscriptionId' IS DISTINCT FROM subscription_id
    OR x->'intent'->>'resourceGroup' IS DISTINCT FROM resource_group
    OR x->'intent'->>'location' IS DISTINCT FROM location
    OR x->'intent'->>'setupNonce' IS DISTINCT FROM original->>'setupNonce'))
 THEN RETURN NULL; END IF;
 context:=jsonb_build_object('version',1,'ownerId',owner_id,'attemptId',r->>'attemptId',
  'hushhId',agent.hushh_id,'tenantId',tenant_id,'subscriptionId',subscription_id,
  'resourceGroup',resource_group,'location',location,
  'setupNonce',coalesce(s->'backend_metadata'->>'setupNonce',original->>'setupNonce'),
  'neverDeployed',public.azure_setup_never_deployed(owner_id,s),
  'snapshotSha256',encode(sha256(convert_to(s::text,'UTF8')),'hex'),
  'setupHistorySha256',encode(sha256(convert_to(job.stages::text,'UTF8')),'hex'));
 RETURN context||jsonb_build_object('digest',encode(sha256(convert_to(context::text,'UTF8')),'hex'));
END;
$function$
$object$;
 ELSIF encode(sha256(convert_to(actual,'UTF8')),'hex') NOT IN ('7dcc8f5263ee06b915f552e4e9febd898ae00e435e18c411dccdf0efd59fa749') THEN
  RAISE EXCEPTION 'Unqualified schema drift: azure_erasure_context';
 END IF;
END
$object_guard$;

REVOKE ALL ON FUNCTION public."azure_erasure_context"(text) FROM PUBLIC;

DO $pod_414$
BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN GRANT EXECUTE ON FUNCTION public."azure_erasure_context"(text) TO service_role; END IF;
END
$pod_414$;

DO $object_guard$
DECLARE actual text;
BEGIN
 SELECT definition INTO actual FROM (SELECT pg_get_functiondef(p.oid) definition FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='azure_erasure_execution_receipt' AND pg_get_function_identity_arguments(p.oid)='state jsonb, stage text, outcome text') observed;
 IF actual IS NULL THEN
  EXECUTE $object$CREATE OR REPLACE FUNCTION public.azure_erasure_execution_receipt(state jsonb, stage text, outcome text)
 RETURNS jsonb
 LANGUAGE plpgsql
 IMMUTABLE
 SET search_path TO 'public'
AS $function$
DECLARE worker jsonb:=state->'worker'; execution_id text:=worker->>'executionId'; ids jsonb;
 final_receipt jsonb:=state->'finalReadbacks'->execution_id;
BEGIN
 IF worker IS NULL OR execution_id IS NULL THEN RETURN NULL; END IF;
 IF stage='workerExits' AND outcome IN ('returned','failed','cancelled') THEN
  RETURN jsonb_build_object('worker',worker,'outcome',outcome,'finalReadbackSha256',
   CASE WHEN final_receipt IS NULL THEN NULL ELSE
    encode(sha256(convert_to(final_receipt::text,'UTF8')),'hex') END);
 END IF;
 IF stage IS DISTINCT FROM 'finalReadbacks' OR outcome IS NOT NULL
 OR jsonb_typeof(state->'resources') IS DISTINCT FROM 'object' THEN RETURN NULL; END IF;
 SELECT jsonb_agg(key ORDER BY key) INTO ids FROM jsonb_each(state->'plan'->'resources')
 WHERE value->'coveredBy'='null'::jsonb;
 IF EXISTS(SELECT 1 FROM jsonb_each(state->'plan'->'resources') item
  WHERE item.key ~ '/providers/Microsoft[.](KeyVault/vaults|Storage/storageAccounts|CognitiveServices/accounts)/[^/]+$'
   AND item.value->'coveredBy'='null'::jsonb
   AND public.valid_azure_retention_receipt(state->'plan',item.key,state->'resources'->item.key->'retention') IS NOT TRUE)
 THEN RETURN NULL; END IF;
 IF ids IS NULL OR ids IS DISTINCT FROM
  (SELECT jsonb_agg(key ORDER BY key) FROM jsonb_each(state->'resources'))
 OR EXISTS(SELECT 1 FROM jsonb_each(state->'resources') r
   WHERE public.azure_erasure_absence_settled(r.value) IS NOT TRUE
   OR r.value->'absence' IS DISTINCT FROM
     jsonb_build_object('status','active_resource_absent','id',r.key)) THEN RETURN NULL; END IF;
 RETURN jsonb_build_object('worker',worker,'status','active_resources_absent',
  'planDigest',encode(sha256(convert_to((state->'plan')::text,'UTF8')),'hex'),
  'resourcesSha256',encode(sha256(convert_to((state->'resources')::text,'UTF8')),'hex'),
  'resourceIdsSha256',encode(sha256(convert_to(ids::text,'UTF8')),'hex'));
END;
$function$
$object$;
 ELSIF encode(sha256(convert_to(actual,'UTF8')),'hex') NOT IN ('7c4e75bd0c907234c6f12fc7f7eda0deac497bcaa72683496c07b8fb00cfab77') THEN
  RAISE EXCEPTION 'Unqualified schema drift: azure_erasure_execution_receipt';
 END IF;
END
$object_guard$;

REVOKE ALL ON FUNCTION public."azure_erasure_execution_receipt"(jsonb, text, text) FROM PUBLIC;

DO $pod_414$
BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN GRANT EXECUTE ON FUNCTION public."azure_erasure_execution_receipt"(jsonb, text, text) TO service_role; END IF;
END
$pod_414$;

DO $object_guard$
DECLARE actual text;
BEGIN
 SELECT definition INTO actual FROM (SELECT pg_get_functiondef(p.oid) definition FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='azure_erasure_request_retryable' AND pg_get_function_identity_arguments(p.oid)='resource jsonb') observed;
 IF actual IS NULL THEN
  EXECUTE $object$CREATE OR REPLACE FUNCTION public.azure_erasure_request_retryable(resource jsonb)
 RETURNS boolean
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public'
AS $function$
 SELECT coalesce(resource->'provider_terminal'->>'outcome'='not_dispatched' OR (
  resource->'provider_terminal'->>'outcome'='refused'
  AND resource->'provider_ack'->>'status' IN ('400','401','403','405','412','422','429')),false);
$function$
$object$;
 ELSIF encode(sha256(convert_to(actual,'UTF8')),'hex') NOT IN ('6ee6ac90a4e6fce71ef2b0296d6fb52cf0dd700111c53f25d00b064c59b39c7a') THEN
  RAISE EXCEPTION 'Unqualified schema drift: azure_erasure_request_retryable';
 END IF;
END
$object_guard$;

REVOKE ALL ON FUNCTION public."azure_erasure_request_retryable"(jsonb) FROM PUBLIC;

DO $pod_414$
BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN GRANT EXECUTE ON FUNCTION public."azure_erasure_request_retryable"(jsonb) TO service_role; END IF;
END
$pod_414$;

DO $object_guard$
DECLARE actual text;
BEGIN
 SELECT definition INTO actual FROM (SELECT pg_get_functiondef(p.oid) definition FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='azure_erasure_resources_complete' AND pg_get_function_identity_arguments(p.oid)='owner_id text, r jsonb') observed;
 IF actual IS NULL THEN
  EXECUTE $object$CREATE OR REPLACE FUNCTION public.azure_erasure_resources_complete(owner_id text, r jsonb)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public'
AS $function$
DECLARE state jsonb:=r->'azureTeardown'; context jsonb:=public.azure_erasure_context(owner_id);
 plan jsonb:=state->'plan'; worker jsonb:=state->'worker'; approval jsonb;
 final_receipt jsonb; exited jsonb; group_path text; parent_pattern text; item record;
BEGIN
 IF context IS NULL OR ((r->'registrySnapshot'->>'backend' IS DISTINCT FROM 'user_azure'
 OR r->'registrySnapshot'->>'deployment_target' IS DISTINCT FROM 'user_azure')
 AND public.azure_setup_never_deployed(owner_id,r->'registrySnapshot') IS NOT TRUE)
 OR nullif(r->'registrySnapshot'->>'user_cloud_project','') IS NOT NULL
 OR public.valid_azure_erasure_plan(owner_id,plan) IS NOT TRUE
 OR plan->>'termsVersion' IS DISTINCT FROM 'azure-exact-parent-retention-v2'
 OR public.azure_erasure_writers_drained(owner_id) IS NOT TRUE
 OR state->'setupHistory' IS DISTINCT FROM public.azure_erasure_setup_history(owner_id)
 OR public.azure_cleanup_information_erased(owner_id,r) IS NOT TRUE
 OR (r ? 'ownerAccessErasure' AND public.valid_erasure_owner_access(r,r->'ownerAccessErasure') IS NOT TRUE)
 OR nullif(worker->>'executionId','') IS NULL THEN RETURN false; END IF;
 group_path:='/subscriptions/'||(context->>'subscriptionId')||'/resourceGroups/'||(context->>'resourceGroup');
 IF plan->'resources'->group_path->>'deletionScope' IS DISTINCT FROM 'whole_group'
 OR plan->'resources'->group_path->'coveredBy' IS DISTINCT FROM 'null'::jsonb
 THEN RETURN false; END IF;
 -- Each cost/custody parent must have independent active-absence evidence.
 -- Runtime reconstruction additionally checks the complete canonical plan.
 FOREACH parent_pattern IN ARRAY ARRAY[
  '/Microsoft[.]App/containerApps/[^/]+$', '/Microsoft[.]App/managedEnvironments/[^/]+$',
  '/Microsoft[.]ManagedIdentity/userAssignedIdentities/[^/]+$', '/Microsoft[.]KeyVault/vaults/[^/]+$',
  '/Microsoft[.]Storage/storageAccounts/[^/]+$', '/Microsoft[.]ContainerRegistry/registries/[^/]+$',
  '/Microsoft[.]CognitiveServices/accounts/[^/]+$', '/Microsoft[.]CognitiveServices/accounts/[^/]+/deployments/one-chat$'
 ] LOOP
  IF (SELECT count(*) FROM jsonb_each(plan->'resources') x WHERE x.key ~ parent_pattern
    AND x.value->>'kind'='resource' AND x.value->'coveredBy'='null'::jsonb)<>1
  THEN RETURN false; END IF;
 END LOOP;
 -- An older setup may not hide writes to another group or another cloud.
 FOR item IN SELECT value FROM jsonb_array_elements(state->'setupHistory')
   WHERE value->>'stage'='azure_provider_request' LOOP
  IF NOT (item.value->>'path'=group_path OR starts_with(item.value->>'path',group_path||'/'))
   AND NOT (item.value->>'method'='POST' AND item.value->>'path' IN (
    '/subscriptions/'||(context->>'subscriptionId')||'/providers/Microsoft.App/register',
    '/subscriptions/'||(context->>'subscriptionId')||'/providers/Microsoft.ManagedIdentity/register',
    '/subscriptions/'||(context->>'subscriptionId')||'/providers/Microsoft.KeyVault/register',
    '/subscriptions/'||(context->>'subscriptionId')||'/providers/Microsoft.Storage/register',
    '/subscriptions/'||(context->>'subscriptionId')||'/providers/Microsoft.ContainerRegistry/register',
    '/subscriptions/'||(context->>'subscriptionId')||'/providers/Microsoft.CognitiveServices/register'))
  THEN RETURN false; END IF;
 END LOOP;
 approval:=state->'approvals'->((worker->>'approvalIndex')::integer);
 IF approval->>'ownerId' IS DISTINCT FROM owner_id
 OR approval->>'attemptId' IS DISTINCT FROM r->>'attemptId'
 OR approval->>'scope' IS DISTINCT FROM 'exact_plan'
 OR approval->>'groupConfirmation' IS DISTINCT FROM group_path
 OR approval->>'planDigest' IS DISTINCT FROM encode(sha256(convert_to(plan::text,'UTF8')),'hex')
 THEN RETURN false; END IF;
 -- Expiry governs new effects, not evidence of a completed authorized effect.
 final_receipt:=public.azure_erasure_execution_receipt(state,'finalReadbacks',NULL);
 exited:=public.azure_erasure_execution_receipt(state,'workerExits','returned');
 RETURN final_receipt IS NOT NULL AND exited IS NOT NULL
 AND state->'finalReadbacks'->(worker->>'executionId')=final_receipt
 AND state->'workerExits'->(worker->>'executionId')=exited;
EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN RETURN false;
END;
$function$
$object$;
 ELSIF encode(sha256(convert_to(actual,'UTF8')),'hex') NOT IN ('8080a9d14ac98994bc7ed21d187ad956b773c0cdf157b7ca549a36403a66c67b') THEN
  RAISE EXCEPTION 'Unqualified schema drift: azure_erasure_resources_complete';
 END IF;
END
$object_guard$;

REVOKE ALL ON FUNCTION public."azure_erasure_resources_complete"(text, jsonb) FROM PUBLIC;

DO $pod_414$
BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN GRANT EXECUTE ON FUNCTION public."azure_erasure_resources_complete"(text, jsonb) TO service_role; END IF;
END
$pod_414$;

DO $object_guard$
DECLARE actual text;
BEGIN
 SELECT definition INTO actual FROM (SELECT pg_get_functiondef(p.oid) definition FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='azure_erasure_setup_history' AND pg_get_function_identity_arguments(p.oid)='owner_id text') observed;
 IF actual IS NULL THEN
  EXECUTE $object$CREATE OR REPLACE FUNCTION public.azure_erasure_setup_history(owner_id text)
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
 SELECT j.stages FROM public.byoc_setup_jobs j
 WHERE j.user_id=owner_id AND jsonb_typeof(j.stages)='array'
 AND encode(sha256(convert_to(j.stages::text,'UTF8')),'hex')=
    public.azure_erasure_context(owner_id)->>'setupHistorySha256';
$function$
$object$;
 ELSIF encode(sha256(convert_to(actual,'UTF8')),'hex') NOT IN ('242f770ea184b4ff86a75847b804ebd50c0fc8c9d5eb7d9b5aa005fe6a920e75') THEN
  RAISE EXCEPTION 'Unqualified schema drift: azure_erasure_setup_history';
 END IF;
END
$object_guard$;

REVOKE ALL ON FUNCTION public."azure_erasure_setup_history"(text) FROM PUBLIC;

DO $pod_414$
BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN GRANT EXECUTE ON FUNCTION public."azure_erasure_setup_history"(text) TO service_role; END IF;
END
$pod_414$;

DO $object_guard$
DECLARE actual text;
BEGIN
 SELECT definition INTO actual FROM (SELECT pg_get_functiondef(p.oid) definition FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='azure_erasure_writers_drained' AND pg_get_function_identity_arguments(p.oid)='owner_id text') observed;
 IF actual IS NULL THEN
  EXECUTE $object$CREATE OR REPLACE FUNCTION public.azure_erasure_writers_drained(owner_id text)
 RETURNS boolean
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
 WITH context AS (SELECT public.azure_erasure_context(owner_id) value), history AS (
  SELECT jsonb_array_elements(j.stages) event FROM public.byoc_setup_jobs j WHERE j.user_id=owner_id
 ) SELECT context.value IS NOT NULL AND EXISTS(
  -- A journalled original setup cannot stand in for a later unjournalled
  -- upgrade or rebuild. The current job must have its own real worker witness.
  SELECT 1 FROM public.byoc_setup_jobs current_job JOIN history worker ON
   worker.event->>'jobId'=current_job.job_id
  WHERE current_job.user_id=owner_id AND worker.event->>'stage'='azure_worker_started'
 ) AND EXISTS(
  SELECT 1 FROM history request JOIN history ack ON ack.event->>'requestId'=request.event->>'requestId'
  JOIN history terminal ON terminal.event->>'requestId'=request.event->>'requestId'
  WHERE request.event->>'stage'='azure_provider_request'
   AND request.event->>'method'='PUT' AND request.event->>'purpose'='creating_resource_group'
   AND request.event->>'path'='/subscriptions/'||(context.value->>'subscriptionId')||
     '/resourceGroups/'||(context.value->>'resourceGroup')
   AND ack.event->>'stage'='azure_provider_ack' AND ack.event->'status'='201'::jsonb
   AND terminal.event->>'stage'='azure_provider_terminal' AND terminal.event->>'outcome'='succeeded'
 ) FROM context;
$function$
$object$;
 ELSIF encode(sha256(convert_to(actual,'UTF8')),'hex') NOT IN ('18c9f439af7386ad4e4428215f3a7f0a4a551ed01df1a939006b92a75fb57cdb') THEN
  RAISE EXCEPTION 'Unqualified schema drift: azure_erasure_writers_drained';
 END IF;
END
$object_guard$;

REVOKE ALL ON FUNCTION public."azure_erasure_writers_drained"(text) FROM PUBLIC;

DO $pod_414$
BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN GRANT EXECUTE ON FUNCTION public."azure_erasure_writers_drained"(text) TO service_role; END IF;
END
$pod_414$;

DO $object_guard$
DECLARE actual text;
BEGIN
 SELECT definition INTO actual FROM (SELECT pg_get_functiondef(p.oid) definition FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='azure_files_upgrade_admission_ready' AND pg_get_function_identity_arguments(p.oid)='') observed;
 IF actual IS NULL THEN
  EXECUTE $object$CREATE OR REPLACE FUNCTION public.azure_files_upgrade_admission_ready()
 RETURNS boolean
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
 SELECT public.files_upgrade_admission_ready()
 AND to_regprocedure('public.valid_erasure_azure_files_upgrade_observation(jsonb,jsonb)') IS NOT NULL
 AND to_regprocedure('public.effective_erasure_azure_files_inventory(jsonb)') IS NOT NULL
 AND position('valid_erasure_azure_files_upgrade_observation' IN
   pg_get_functiondef('public.valid_erasure_files_upgrade_observation(jsonb,jsonb)'::regprocedure))>0;
$function$
$object$;
 ELSIF encode(sha256(convert_to(actual,'UTF8')),'hex') NOT IN ('f72b0e916f42c5f4bb4de04ea54e3257260a036800ed9d752ef4d7c00e5cf1ad') THEN
  RAISE EXCEPTION 'Unqualified schema drift: azure_files_upgrade_admission_ready';
 END IF;
END
$object_guard$;

REVOKE ALL ON FUNCTION public."azure_files_upgrade_admission_ready"() FROM PUBLIC;

DO $pod_414$
BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN GRANT EXECUTE ON FUNCTION public."azure_files_upgrade_admission_ready"() TO service_role; END IF;
END
$pod_414$;

DO $object_guard$
DECLARE actual text;
BEGIN
 SELECT definition INTO actual FROM (SELECT pg_get_functiondef(p.oid) definition FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='azure_setup_never_deployed' AND pg_get_function_identity_arguments(p.oid)='owner_id text, snapshot jsonb') observed;
 IF actual IS NULL THEN
  EXECUTE $object$CREATE OR REPLACE FUNCTION public.azure_setup_never_deployed(owner_id text, snapshot jsonb)
 RETURNS boolean
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
 SELECT public.azure_setup_predeployment_proven(owner_id,snapshot,true);
$function$
$object$;
 ELSIF encode(sha256(convert_to(actual,'UTF8')),'hex') NOT IN ('bf3bee47b9356683eb862d2da4a77539fb759c7359e6f15c41653d73cd9bbf87') THEN
  RAISE EXCEPTION 'Unqualified schema drift: azure_setup_never_deployed';
 END IF;
END
$object_guard$;

REVOKE ALL ON FUNCTION public."azure_setup_never_deployed"(text, jsonb) FROM PUBLIC;

DO $pod_414$
BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN GRANT EXECUTE ON FUNCTION public."azure_setup_never_deployed"(text, jsonb) TO service_role; END IF;
END
$pod_414$;

DO $object_guard$
DECLARE actual text;
BEGIN
 SELECT definition INTO actual FROM (SELECT pg_get_functiondef(p.oid) definition FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='azure_setup_no_effects' AND pg_get_function_identity_arguments(p.oid)='owner_id text') observed;
 IF actual IS NULL THEN
  EXECUTE $object$CREATE OR REPLACE FUNCTION public.azure_setup_no_effects(owner_id text)
 RETURNS boolean
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
 SELECT coalesce(public.azure_setup_predeployment_proven(owner_id,to_jsonb(p),false),false)
 FROM public.personal_agent_registry p WHERE user_id=owner_id;
$function$
$object$;
 ELSIF encode(sha256(convert_to(actual,'UTF8')),'hex') NOT IN ('ceaecb04a1663b2e3d0c0c6400a6ebc473eba46859f38212c8af25668f9d8123') THEN
  RAISE EXCEPTION 'Unqualified schema drift: azure_setup_no_effects';
 END IF;
END
$object_guard$;

REVOKE ALL ON FUNCTION public."azure_setup_no_effects"(text) FROM PUBLIC;

DO $pod_414$
BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN GRANT EXECUTE ON FUNCTION public."azure_setup_no_effects"(text) TO service_role; END IF;
END
$pod_414$;

DO $object_guard$
DECLARE actual text;
BEGIN
 SELECT definition INTO actual FROM (SELECT pg_get_functiondef(p.oid) definition FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='azure_setup_predeployment_proven' AND pg_get_function_identity_arguments(p.oid)='owner_id text, snapshot jsonb, require_resources boolean') observed;
 IF actual IS NULL THEN
  EXECUTE $object$CREATE OR REPLACE FUNCTION public.azure_setup_predeployment_proven(owner_id text, snapshot jsonb, require_resources boolean)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public'
AS $function$
DECLARE live public.personal_agent_registry%ROWTYPE; job public.byoc_setup_jobs%ROWTYPE;
 item jsonb; first_intent jsonb; intent jsonb; history jsonb; group_path text;
BEGIN
 IF public.byoc_azure_setup_guards_ready() IS NOT TRUE
 OR snapshot->>'user_id' IS DISTINCT FROM owner_id
 OR (snapshot->>'status' IN ('pending','unprovisioned')) IS NOT TRUE
 OR nullif(snapshot->>'deployment_target','') IS NOT NULL
 OR EXISTS (SELECT 1 FROM unnest(ARRAY['backend','external_agent_id','a2a_route','pod_pubkey',
   'pod_key_id','pod_key_wrapping_alg','attestation_ref','provisioned_at','user_cloud_project',
   'space_id','region','user_cloud_bootstrap_sa','user_cloud_authorized_at','user_cloud_region',
   'user_cloud_tenant_id','user_cloud_subscription_id','user_cloud_resource_group']) f
   WHERE nullif(snapshot->>f,'') IS NOT NULL)
 OR coalesce(snapshot->'backend_metadata','null'::jsonb) NOT IN ('null'::jsonb,'{}'::jsonb)
 OR EXISTS(SELECT 1 FROM public.personal_agent_deletion_tombstones
   WHERE hushh_id=snapshot->>'hushh_id')
 OR EXISTS(SELECT 1 FROM public.consent_audit WHERE user_id=owner_id
   AND agent_id='personal_agent' AND action='CONSENT_GRANTED')
 OR EXISTS(SELECT 1 FROM public.pod_migration_jobs WHERE user_id=owner_id)
 OR EXISTS(SELECT 1 FROM public.personal_agent_standby_placements WHERE user_id=owner_id)
 OR EXISTS(SELECT 1 FROM public.pod_lifecycle_events WHERE user_id=owner_id AND (
   hushh_id IS DISTINCT FROM snapshot->>'hushh_id' OR substrate_step IS NOT NULL
   OR NOT ((coalesce(event,'')='stage' AND coalesce(stage,'') IN ('registry_row','failed'))
     OR (coalesce(event,'')='terminal' AND coalesce(stage,'')='failed'))))
 THEN RETURN false; END IF;
 SELECT * INTO live FROM public.personal_agent_registry WHERE user_id=owner_id;
 IF NOT FOUND OR live.hushh_id IS DISTINCT FROM snapshot->>'hushh_id'
 OR coalesce(live.backend_metadata->'erasure'->'registrySnapshot',to_jsonb(live))
   -ARRAY['updated_at','last_heartbeat_at','health_state','liveness_failures'] IS DISTINCT FROM
   snapshot-ARRAY['updated_at','last_heartbeat_at','health_state','liveness_failures']
 THEN RETURN false; END IF;
 SELECT * INTO job FROM public.byoc_setup_jobs WHERE user_id=owner_id;
 IF NOT FOUND OR job.status IS DISTINCT FROM 'failed' OR job.authorization_attempts IS DISTINCT FROM '{}'::jsonb
 OR jsonb_typeof(job.stages) IS DISTINCT FROM 'array' THEN RETURN false; END IF;
 history:=job.stages;
 SELECT x->'intent' INTO first_intent FROM jsonb_array_elements(history) x
 WHERE x->>'stage' IN ('azure_setup_intent','azure_setup_prior_intent') LIMIT 1;
 IF first_intent IS NULL THEN RETURN false; END IF;
 group_path:=job.project_id;
 FOR item IN SELECT value FROM jsonb_array_elements(history) LOOP
  IF item->>'stage' IN ('azure_setup_intent','azure_setup_prior_intent') THEN
   intent:=item->'intent';
   IF intent->'version' IS DISTINCT FROM '1'::jsonb
   OR public.valid_byoc_azure_setup_intent(owner_id,intent->>'jobId',group_path,live.hushh_id,intent) IS NOT TRUE
   OR intent-ARRAY['jobId','groupInitiallyAbsent','setupNonce'] IS DISTINCT FROM first_intent-ARRAY['jobId','groupInitiallyAbsent','setupNonce']
   OR (require_resources IS TRUE AND intent->'setupNonce' IS DISTINCT FROM first_intent->'setupNonce')
   OR (require_resources IS FALSE AND intent->'groupInitiallyAbsent' IS DISTINCT FROM 'true'::jsonb)
   OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(history) w
     WHERE w->>'stage'='azure_worker_started' AND w->>'jobId'=intent->>'jobId')
   THEN RETURN false; END IF;
  ELSIF item->>'stage'='azure_worker_started' THEN
   IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(history) x WHERE x->>'stage'='azure_worker_exited'
     AND x->>'executionId'=item->>'executionId' AND x->>'jobId'=item->>'jobId')
   THEN RETURN false; END IF;
  ELSIF item->>'stage'='azure_provider_request' THEN
   IF (item->>'purpose' IN ('creating_resource_group','registering_providers','creating_identity',
      'creating_key_vault','creating_storage','creating_registry','creating_model')) IS NOT TRUE
   OR item->>'path' ~* '/Microsoft[.]App/containerApps/'
   OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(history) x WHERE x->>'stage'='azure_provider_terminal'
     AND x->>'requestId'=item->>'requestId' AND x->>'executionId'=item->>'executionId'
     AND (x->>'outcome' IN ('succeeded','failed','not_dispatched')
      OR (x->>'outcome'='refused' AND EXISTS(SELECT 1 FROM jsonb_array_elements(history) ack
       WHERE ack->>'stage'='azure_provider_ack' AND ack->>'requestId'=item->>'requestId'
       AND ack->>'executionId'=item->>'executionId'
       AND ack->>'status' IN ('400','401','403','404','405','409','412','422','429')))))
   THEN RETURN false; END IF;
  END IF;
 END LOOP;
 IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(history) x WHERE x->>'stage'='azure_worker_started'
   AND x->>'jobId'=job.job_id) THEN RETURN false; END IF;
 IF require_resources IS FALSE THEN
  RETURN NOT EXISTS(SELECT 1 FROM jsonb_array_elements(history) x
   WHERE x->>'stage' IN ('azure_provider_request','azure_provider_ack','azure_provider_terminal'));
 END IF;
 RETURN EXISTS(SELECT 1 FROM jsonb_array_elements(history) request
  JOIN jsonb_array_elements(history) ack ON ack->>'requestId'=request->>'requestId'
  JOIN jsonb_array_elements(history) terminal ON terminal->>'requestId'=request->>'requestId'
  WHERE request->>'stage'='azure_provider_request' AND request->>'method'='PUT'
   AND request->>'path'=group_path AND request->>'purpose'='creating_resource_group'
   AND ack->>'stage'='azure_provider_ack' AND ack->'status'='201'::jsonb
   AND terminal->>'stage'='azure_provider_terminal' AND terminal->>'outcome'='succeeded');
END;
$function$
$object$;
 ELSIF encode(sha256(convert_to(actual,'UTF8')),'hex') NOT IN ('d688190b3ff9498bb03a856ffb655673d0c8a2468abf16d9f8b03c1e01a9f2a4') THEN
  RAISE EXCEPTION 'Unqualified schema drift: azure_setup_predeployment_proven';
 END IF;
END
$object_guard$;

REVOKE ALL ON FUNCTION public."azure_setup_predeployment_proven"(text, jsonb, boolean) FROM PUBLIC;

DO $pod_414$
BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN GRANT EXECUTE ON FUNCTION public."azure_setup_predeployment_proven"(text, jsonb, boolean) TO service_role; END IF;
END
$pod_414$;

DO $object_guard$
DECLARE actual text;
BEGIN
 SELECT definition INTO actual FROM (SELECT pg_get_functiondef(p.oid) definition FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='azure_vm_image_publication_proven' AND pg_get_function_identity_arguments(p.oid)='prior personal_agent_registry, incoming personal_agent_registry') observed;
 IF actual IS NULL THEN
  EXECUTE $object$CREATE OR REPLACE FUNCTION public.azure_vm_image_publication_proven(prior personal_agent_registry, incoming personal_agent_registry)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public'
AS $function$
DECLARE old_m jsonb:=prior.backend_metadata; new_m jsonb:=incoming.backend_metadata;
 approval jsonb:=old_m->'upgradeApproval'; ack jsonb:=old_m->'upgradeAcknowledgement';
 proof jsonb:=new_m->'vmUpdateVerification'; host_ack jsonb:=proof->'host';
 recovery jsonb:=proof->'recovery'; released jsonb:=proof->'released';
 job public.byoc_setup_jobs; intent jsonb; intents jsonb; target text; digest_value text;
 mutable text[]:=ARRAY['image','image_digest','vmHost','vmConfigurationSha256','vmPower',
  'upgradeLease','vmUpdateVerification','upgradeAcknowledgement','upgradeApproval',
  'installedRelease','source_image','previous_image','upgraded','observed','imageSetByRevision','upgrade'];
BEGIN
 SELECT * INTO job FROM public.byoc_setup_jobs WHERE user_id=prior.user_id;
 IF job IS NULL OR jsonb_typeof(job.stages) IS DISTINCT FROM 'array' THEN RETURN false; END IF;
 SELECT jsonb_agg(e->'intent') INTO intents FROM jsonb_array_elements(job.stages) e
 WHERE e->>'stage' IN ('azure_setup_intent','azure_setup_prior_intent')
  AND e->'intent'->'version'='3'::jsonb
  AND e->'intent'->>'operationId'=approval->>'operationId';
 IF jsonb_array_length(intents) IS DISTINCT FROM 1 THEN RETURN false; END IF;
 intent:=intents->0;
 digest_value:=right(intent->>'sourceImage',71);
 target:=split_part(old_m->>'image','@',1)||'@'||digest_value;
 IF prior.status IS DISTINCT FROM 'provisioned' OR prior.backend IS DISTINCT FROM 'user_azure'
 OR prior.deployment_target IS DISTINCT FROM 'user_azure' OR old_m->>'hostKind' IS DISTINCT FROM 'azure_vm'
 OR old_m ? 'erasure' OR new_m ?| ARRAY['erasure','upgradeLease','vmPower']
 OR public.azure_vm_power_pending(old_m) IS TRUE
 OR (old_m ? 'vmPower' AND old_m->'vmPower'->'binding' IS DISTINCT FROM public.azure_vm_power_binding(to_jsonb(prior)))
 OR (to_jsonb(prior)-ARRAY['backend_metadata','updated_at']) IS DISTINCT FROM
    (to_jsonb(incoming)-ARRAY['backend_metadata','updated_at'])
 OR old_m-mutable IS DISTINCT FROM new_m-mutable
 OR intent->'binding' IS DISTINCT FROM public.azure_vm_upgrade_registry_binding(to_jsonb(prior))
 OR public.valid_byoc_azure_vm_upgrade_intent(prior.user_id,intent->>'jobId',job.project_id,prior.hushh_id,intent) IS NOT TRUE
 OR intent->>'attemptId' IS DISTINCT FROM encode(sha256(convert_to(old_m->>'upgradeLease','UTF8')),'hex')
 OR intent->>'sourceImage' IS DISTINCT FROM approval->>'targetImage'
 OR EXISTS(SELECT 1 FROM unnest(ARRAY['operationId','releaseId','idempotencyKey']) k
    WHERE intent->k IS DISTINCT FROM approval->k)
 OR approval->>'ownerId' IS DISTINCT FROM prior.user_id OR approval->>'hushhId' IS DISTINCT FROM prior.hushh_id
 OR approval->>'podIncarnation' IS DISTINCT FROM old_m->>'serviceUid'
 OR approval->'version' IS DISTINCT FROM '1'::jsonb
 OR coalesce(approval->'capabilityPlanDigest','null'::jsonb)<>'null'::jsonb
 OR (approval->>'status' IN ('approved','scheduled','updating','blocked')) IS NOT TRUE
 OR (new_m->'upgradeApproval')-ARRAY['status','operationState','presentationPhase','verifiedAt']
    IS DISTINCT FROM approval-ARRAY['status','operationState','presentationPhase','verifiedAt']
 OR new_m->'upgradeApproval'->>'status' IS DISTINCT FROM 'succeeded'
 OR new_m->'upgradeApproval'->>'operationState' IS DISTINCT FROM 'succeeded'
 OR new_m->'upgradeApproval'->>'presentationPhase' IS DISTINCT FROM 'verified'
 OR new_m->>'source_image' IS DISTINCT FROM intent->>'sourceImage'
 OR new_m->>'image' IS DISTINCT FROM target OR new_m->>'image_digest' IS DISTINCT FROM digest_value
 OR new_m->>'previous_image' IS DISTINCT FROM old_m->>'image'
 OR new_m->'vmHost' IS DISTINCT FROM jsonb_set(old_m->'vmHost','{installation,image_digest}',to_jsonb(digest_value))
 OR proof-ARRAY['operationId','attemptId','host','recovery','released','previousPower']<>'{}'::jsonb
 OR proof->'previousPower' IS DISTINCT FROM old_m->'vmPower'
 OR proof->'operationId' IS DISTINCT FROM intent->'operationId'
 OR proof->'attemptId' IS DISTINCT FROM intent->'attemptId'
 OR ack->'vmHostAck' IS DISTINCT FROM host_ack
 OR new_m->'upgradeAcknowledgement' IS DISTINCT FROM (ack||jsonb_build_object('outcome','ready'))
 OR ack->'attemptId' IS DISTINCT FROM intent->'attemptId'
 OR ack->'operationId' IS DISTINCT FROM intent->'operationId'
 OR ack->'releaseId' IS DISTINCT FROM intent->'releaseId'
 OR ack->>'externalAgentId' IS DISTINCT FROM prior.external_agent_id
 OR ack->>'service' IS DISTINCT FROM prior.external_agent_id
 OR ack->'serviceUid' IS DISTINCT FROM old_m->'serviceUid'
 OR ack->>'hostKind' IS DISTINCT FROM 'azure_vm' OR ack->'version' IS DISTINCT FROM '1'::jsonb
 OR ack->>'image' IS DISTINCT FROM target OR ack->>'targetImage' IS DISTINCT FROM intent->>'sourceImage'
 OR approval->'handoffIdleRecord' IS DISTINCT FROM intent->'idleRecord'
 OR public.valid_pod_upgrade_cursor(approval->'handoffCommittedCursor') IS NOT TRUE
 OR ack->'idleReceipt'->'operationId' IS DISTINCT FROM intent->'operationId'
 OR ack->'idleReceipt'->'incarnation' IS DISTINCT FROM old_m->'serviceUid'
 OR ack->'idleReceipt'->'runtimeEpoch' IS DISTINCT FROM approval->'handoffRuntimeEpoch'
 OR ack->'idleReceipt'->'activeWork' IS DISTINCT FROM '0'::jsonb
 OR ack->'idleReceipt'->'committedCursor' IS DISTINCT FROM approval->'handoffCommittedCursor'
 OR ack->'idleReceipt'->'committedState' IS DISTINCT FROM approval->'handoffCommittedState'
 OR ack->'idleReceipt'->'idleRecord' IS DISTINCT FROM intent->'idleRecord'
 OR (intent->'idleRecord'->>'seq')::numeric<=(approval->'handoffCommittedCursor'->>'seq')::numeric
 OR approval->>'handoffCommittedState' IS DISTINCT FROM encode(sha256(convert_to(
    (intent->>'operationId')||'|'||(old_m->>'serviceUid')||'|'||
    (approval->'handoffCommittedCursor'->>'seq')||'|'||
    (approval->'handoffCommittedCursor'->>'sha')||'|active=0','UTF8')),'hex')
 OR host_ack-ARRAY['version','operation_id','request_sha256','configuration_sha256','image','stage','application_verified']<>'{}'::jsonb
 OR host_ack->'version' IS DISTINCT FROM '1'::jsonb
 OR host_ack->'operation_id' IS DISTINCT FROM intent->'operationId'
 OR host_ack->'request_sha256' IS DISTINCT FROM intent->'hostRequestSha256'
 OR host_ack->>'image' IS DISTINCT FROM target OR host_ack->>'stage' IS DISTINCT FROM 'restart_requested'
 OR host_ack->'application_verified' IS DISTINCT FROM 'false'::jsonb
 OR host_ack->'configuration_sha256' IS DISTINCT FROM new_m->'vmConfigurationSha256'
 OR (new_m->>'vmConfigurationSha256' ~ '^[a-f0-9]{64}$') IS NOT TRUE
 OR new_m->'vmConfigurationSha256' IS NOT DISTINCT FROM old_m->'vmConfigurationSha256'
 OR recovery->>'kind' IS DISTINCT FROM 'recovery'
 OR recovery->'incarnation' IS DISTINCT FROM old_m->'serviceUid'
 OR recovery->>'podKeyId' IS DISTINCT FROM prior.pod_key_id
 OR recovery->>'imageDigest' IS DISTINCT FROM digest_value
 OR (recovery->>'runtimeEpoch' ~ '^[A-Za-z0-9_-]+$') IS NOT TRUE
 OR length(recovery->>'runtimeEpoch')>256
 OR recovery->'runtimeEpoch' IS NOT DISTINCT FROM approval->'handoffRuntimeEpoch'
 OR recovery->'retainedIdleRecord' IS DISTINCT FROM intent->'idleRecord'
 OR released->>'kind' IS DISTINCT FROM 'released'
 OR released->'operationId' IS DISTINCT FROM intent->'operationId'
 OR released->'incarnation' IS DISTINCT FROM recovery->'incarnation'
 OR released->'runtimeEpoch' IS DISTINCT FROM recovery->'runtimeEpoch'
 OR public.valid_pod_upgrade_cursor(released->'releaseRecord') IS NOT TRUE
 OR (released->'releaseRecord'->>'seq')::numeric<=(intent->'idleRecord'->>'seq')::numeric
 OR public.azure_vm_upgrade_dispatch_settled(intent,job.stages) IS NOT TRUE
 THEN RETURN false; END IF;
 RETURN true;
END;
$function$
$object$;
 ELSIF encode(sha256(convert_to(actual,'UTF8')),'hex') NOT IN ('5329963e73fc583df179883023536066a523583372c6ebd860d40df84107b918') THEN
  RAISE EXCEPTION 'Unqualified schema drift: azure_vm_image_publication_proven';
 END IF;
END
$object_guard$;

REVOKE ALL ON FUNCTION public."azure_vm_image_publication_proven"(personal_agent_registry, personal_agent_registry) FROM PUBLIC;

DO $pod_414$
BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN GRANT EXECUTE ON FUNCTION public."azure_vm_image_publication_proven"(personal_agent_registry, personal_agent_registry) TO service_role; END IF;
END
$pod_414$;

DO $object_guard$
DECLARE actual text;
BEGIN
 SELECT definition INTO actual FROM (SELECT pg_get_functiondef(p.oid) definition FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='azure_vm_power_binding' AND pg_get_function_identity_arguments(p.oid)='agent jsonb') observed;
 IF actual IS NULL THEN
  EXECUTE $object$CREATE OR REPLACE FUNCTION public.azure_vm_power_binding(agent jsonb)
 RETURNS jsonb
 LANGUAGE sql
 IMMUTABLE
AS $function$
 SELECT jsonb_build_object(
  'ownerId',agent->'user_id','hushhId',agent->'hushh_id',
  'status',agent->'status','backend',agent->'backend',
  'deploymentTarget',agent->'deployment_target','externalAgentId',agent->'external_agent_id',
  'placementEpoch',agent->'placement_epoch','podKeyId',agent->'pod_key_id',
  'podPublicKey',agent->'pod_pubkey','signingKeyId',agent->'pod_signing_key_id',
  'signingPublicKey',agent->'pod_signing_pubkey','tenantId',agent->'user_cloud_tenant_id',
  'subscriptionId',agent->'user_cloud_subscription_id',
  'resourceGroup',agent->'user_cloud_resource_group','region',agent->'user_cloud_region',
  'hostKind',agent->'backend_metadata'->'hostKind',
  'host',agent->'backend_metadata'->'vmHost',
  'url',agent->'backend_metadata'->'url','serviceUid',agent->'backend_metadata'->'serviceUid',
  'image',agent->'backend_metadata'->'image',
  'principalId',agent->'backend_metadata'->'runtime_principal_id',
  'clientId',agent->'backend_metadata'->'runtime_client_id');
$function$
$object$;
 ELSIF encode(sha256(convert_to(actual,'UTF8')),'hex') NOT IN ('09051241181c5ad85220e5e87b62c0eed30ec709065009631f167daf2d54da26') THEN
  RAISE EXCEPTION 'Unqualified schema drift: azure_vm_power_binding';
 END IF;
END
$object_guard$;

REVOKE ALL ON FUNCTION public."azure_vm_power_binding"(jsonb) FROM PUBLIC;

DO $pod_414$
BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN GRANT EXECUTE ON FUNCTION public."azure_vm_power_binding"(jsonb) TO service_role; END IF;
END
$pod_414$;

DO $object_guard$
DECLARE actual text;
BEGIN
 SELECT definition INTO actual FROM (SELECT pg_get_functiondef(p.oid) definition FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='azure_vm_power_eligible' AND pg_get_function_identity_arguments(p.oid)='agent jsonb') observed;
 IF actual IS NULL THEN
  EXECUTE $object$CREATE OR REPLACE FUNCTION public.azure_vm_power_eligible(agent jsonb)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public'
AS $function$
DECLARE m jsonb:=agent->'backend_metadata'; host jsonb:=m->'vmHost'; i jsonb:=host->'installation';
BEGIN
 RETURN coalesce(agent->>'status'='provisioned'
 AND agent->>'deployment_target'='user_azure' AND agent->>'backend'='user_azure'
 AND m->>'hostKind'='azure_vm' AND jsonb_typeof(host)='object'
 AND i->'version'='1'::jsonb AND i->>'hushh_id'=agent->>'hushh_id'
 AND lower(i->>'resource_id')=lower(agent->>'external_agent_id')
 AND lower(i->>'resource_id')=lower(format(
   '/subscriptions/%s/resourceGroups/%s/providers/Microsoft.Compute/virtualMachines/%s',
   agent->>'user_cloud_subscription_id',agent->>'user_cloud_resource_group',
   split_part(agent->>'external_agent_id','/',9)))
 AND i->>'generation'=m->>'serviceUid' AND i->>'client_id'=m->>'runtime_client_id'
 AND host->>'principalId'=m->>'runtime_principal_id' AND host->>'location'=agent->>'user_cloud_region'
 AND right(m->>'image',71)=i->>'image_digest'
 AND nullif(agent->>'pod_key_id','') IS NOT NULL AND nullif(agent->>'pod_pubkey','') IS NOT NULL
 AND nullif(agent->>'pod_signing_key_id','') IS NOT NULL
 AND nullif(agent->>'pod_signing_pubkey','') IS NOT NULL
 AND NOT m ?| ARRAY['erasure','upgradeLease','provisionAttempt']
 AND NOT EXISTS(SELECT 1 FROM personal_agent_deletion_tombstones WHERE hushh_id=agent->>'hushh_id')
 AND NOT EXISTS(SELECT 1 FROM account_deletion_tombstones
   WHERE cleanup_intent_kind='full_account'
   AND user_id_hash='sha256:'||encode(sha256(convert_to(agent->>'user_id','UTF8')),'hex'))
 AND NOT EXISTS(SELECT 1 FROM pod_migration_jobs WHERE user_id=agent->>'user_id')
 AND NOT EXISTS(SELECT 1 FROM personal_agent_standby_placements WHERE user_id=agent->>'user_id')
 AND NOT EXISTS(SELECT 1 FROM byoc_setup_jobs WHERE user_id=agent->>'user_id'
   AND status NOT IN ('recorded','failed')),false);
END;
$function$
$object$;
 ELSIF encode(sha256(convert_to(actual,'UTF8')),'hex') NOT IN ('50fa331292a058afbc2ab5bd39b864f978df749576401a41df15bd5d371e9363') THEN
  RAISE EXCEPTION 'Unqualified schema drift: azure_vm_power_eligible';
 END IF;
END
$object_guard$;

REVOKE ALL ON FUNCTION public."azure_vm_power_eligible"(jsonb) FROM PUBLIC;

DO $pod_414$
BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN GRANT EXECUTE ON FUNCTION public."azure_vm_power_eligible"(jsonb) TO service_role; END IF;
END
$pod_414$;

DO $object_guard$
DECLARE actual text;
BEGIN
 SELECT definition INTO actual FROM (SELECT pg_get_functiondef(p.oid) definition FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='azure_vm_power_pending' AND pg_get_function_identity_arguments(p.oid)='metadata jsonb') observed;
 IF actual IS NULL THEN
  EXECUTE $object$CREATE OR REPLACE FUNCTION public.azure_vm_power_pending(metadata jsonb)
 RETURNS boolean
 LANGUAGE sql
 IMMUTABLE
AS $function$
 SELECT metadata ? 'vmPower' AND
   (metadata->'vmPower'->>'phase' IS DISTINCT FROM 'ready');
$function$
$object$;
 ELSIF encode(sha256(convert_to(actual,'UTF8')),'hex') NOT IN ('17a166f75b92468d908a7cf4e7846e84cfe7988dcc65ce04dbf0f6234dedb1dd') THEN
  RAISE EXCEPTION 'Unqualified schema drift: azure_vm_power_pending';
 END IF;
END
$object_guard$;

REVOKE ALL ON FUNCTION public."azure_vm_power_pending"(jsonb) FROM PUBLIC;

DO $pod_414$
BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN GRANT EXECUTE ON FUNCTION public."azure_vm_power_pending"(jsonb) TO service_role; END IF;
END
$pod_414$;

DO $object_guard$
DECLARE actual text;
BEGIN
 SELECT definition INTO actual FROM (SELECT pg_get_functiondef(p.oid) definition FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='azure_vm_power_phase_proven' AND pg_get_function_identity_arguments(p.oid)='state jsonb, phase text') observed;
 IF actual IS NULL THEN
  EXECUTE $object$CREATE OR REPLACE FUNCTION public.azure_vm_power_phase_proven(state jsonb, phase text)
 RETURNS boolean
 LANGUAGE sql
 IMMUTABLE
AS $function$
 SELECT CASE phase
 WHEN 'drained' THEN EXISTS(SELECT 1 FROM jsonb_array_elements(state->'events') e WHERE e->>'kind'='drain')
 WHEN 'deallocated' THEN EXISTS(SELECT 1 FROM jsonb_array_elements(state->'events') e
   WHERE e->>'kind'='power' AND e->>'state'='deallocated')
 WHEN 'starting' THEN state->>'phase'='deallocated'
 WHEN 'recovered' THEN EXISTS(SELECT 1 FROM jsonb_array_elements(state->'events') e WHERE e->>'kind'='recovery')
   AND EXISTS(SELECT 1 FROM jsonb_array_elements(state->'events') e WHERE e->>'kind'='power' AND e->>'state'='running')
 WHEN 'ready' THEN EXISTS(SELECT 1 FROM jsonb_array_elements(state->'events') e
   WHERE e->>'kind'='released' AND e->>'runtimeEpoch'=(SELECT r->>'runtimeEpoch'
     FROM jsonb_array_elements(state->'events') WITH ORDINALITY items(r,n)
     WHERE r->>'kind'='recovery' ORDER BY n DESC LIMIT 1))
 ELSE false END
 AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(state->'events') request
   WHERE request->>'kind'='request' AND NOT EXISTS(
    SELECT 1 FROM jsonb_array_elements(state->'events') terminal
    WHERE terminal->>'kind'='terminal' AND terminal->>'requestId'=request->>'requestId'));
$function$
$object$;
 ELSIF encode(sha256(convert_to(actual,'UTF8')),'hex') NOT IN ('4a019badb40e2c74ff75405698be8569f6a93d552f6f90b753a1473bea4253d3') THEN
  RAISE EXCEPTION 'Unqualified schema drift: azure_vm_power_phase_proven';
 END IF;
END
$object_guard$;

REVOKE ALL ON FUNCTION public."azure_vm_power_phase_proven"(jsonb, text) FROM PUBLIC;

DO $pod_414$
BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN GRANT EXECUTE ON FUNCTION public."azure_vm_power_phase_proven"(jsonb, text) TO service_role; END IF;
END
$pod_414$;

DO $object_guard$
DECLARE actual text;
BEGIN
 SELECT definition INTO actual FROM (SELECT pg_get_functiondef(p.oid) definition FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='azure_vm_upgrade_dispatch_settled' AND pg_get_function_identity_arguments(p.oid)='intent jsonb, history jsonb') observed;
 IF actual IS NULL THEN
  EXECUTE $object$CREATE OR REPLACE FUNCTION public.azure_vm_upgrade_dispatch_settled(intent jsonb, history jsonb)
 RETURNS boolean
 LANGUAGE plpgsql
 IMMUTABLE
 SET search_path TO 'public'
AS $function$
DECLARE call jsonb; matched integer;
BEGIN
 IF jsonb_typeof(history) IS DISTINCT FROM 'array' THEN RETURN false; END IF;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(history) r
   WHERE r->>'jobId'=intent->>'jobId' AND (
    (r->>'stage'='azure_worker_started' AND NOT EXISTS(
      SELECT 1 FROM jsonb_array_elements(history) e WHERE e->>'stage'='azure_worker_exited'
      AND e->>'jobId'=r->>'jobId' AND e->>'executionId'=r->>'executionId'))
    OR (r->>'stage'='azure_provider_request' AND NOT EXISTS(
      SELECT 1 FROM jsonb_array_elements(history) t WHERE t->>'stage'='azure_provider_terminal'
      AND t->>'jobId'=r->>'jobId' AND t->>'executionId'=r->>'executionId'
      AND t->>'requestId'=r->>'requestId' AND t->>'outcome' IN ('succeeded','not_dispatched')))))
 THEN RETURN false; END IF;
 FOR call IN SELECT value FROM jsonb_array_elements(intent->'allowedRequests') LOOP
  SELECT count(*) INTO matched FROM jsonb_array_elements(history) r
  WHERE r->>'stage'='azure_provider_request' AND r->>'jobId'=intent->>'jobId'
   AND r-ARRAY['stage','jobId','executionId','requestId']=call
   AND EXISTS(SELECT 1 FROM jsonb_array_elements(history) a WHERE a->>'stage'='azure_provider_ack'
     AND a->>'requestId'=r->>'requestId' AND a->>'executionId'=r->>'executionId'
     AND a->>'jobId'=r->>'jobId' AND (a->>'status')::integer BETWEEN 200 AND 299)
   AND EXISTS(SELECT 1 FROM jsonb_array_elements(history) t WHERE t->>'stage'='azure_provider_terminal'
     AND t->>'requestId'=r->>'requestId' AND t->>'executionId'=r->>'executionId'
     AND t->>'jobId'=r->>'jobId' AND t->>'outcome'='succeeded');
  IF matched<>1 THEN RETURN false; END IF;
 END LOOP;
 RETURN true;
END;
$function$
$object$;
 ELSIF encode(sha256(convert_to(actual,'UTF8')),'hex') NOT IN ('9e9cc37b9e92cad88df72c95297e41f477ab402fc0c9fa252337b0d0ef185387') THEN
  RAISE EXCEPTION 'Unqualified schema drift: azure_vm_upgrade_dispatch_settled';
 END IF;
END
$object_guard$;

REVOKE ALL ON FUNCTION public."azure_vm_upgrade_dispatch_settled"(jsonb, jsonb) FROM PUBLIC;

DO $pod_414$
BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN GRANT EXECUTE ON FUNCTION public."azure_vm_upgrade_dispatch_settled"(jsonb, jsonb) TO service_role; END IF;
END
$pod_414$;

DO $object_guard$
DECLARE actual text;
BEGIN
 SELECT definition INTO actual FROM (SELECT pg_get_functiondef(p.oid) definition FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='azure_vm_upgrade_recovery_intent' AND pg_get_function_identity_arguments(p.oid)='agent personal_agent_registry') observed;
 IF actual IS NULL THEN
  EXECUTE $object$CREATE OR REPLACE FUNCTION public.azure_vm_upgrade_recovery_intent(agent personal_agent_registry)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public'
AS $function$
DECLARE job public.byoc_setup_jobs; intents jsonb; intent jsonb;
 approval jsonb:=agent.backend_metadata->'upgradeApproval';
BEGIN
 SELECT * INTO job FROM public.byoc_setup_jobs WHERE user_id=agent.user_id;
 IF job IS NULL OR jsonb_typeof(job.stages) IS DISTINCT FROM 'array' THEN RETURN NULL; END IF;
 SELECT jsonb_agg(e->'intent') INTO intents FROM jsonb_array_elements(job.stages) e
 WHERE e->>'stage' IN ('azure_setup_intent','azure_setup_prior_intent')
 AND e->'intent'->'version'='3'::jsonb AND e->'intent'->>'operationId'=approval->>'operationId';
 IF jsonb_array_length(intents) IS DISTINCT FROM 1 THEN RETURN NULL; END IF;
 intent:=intents->0;
 IF agent.status IS DISTINCT FROM 'provisioned' OR agent.backend IS DISTINCT FROM 'user_azure'
 OR agent.deployment_target IS DISTINCT FROM 'user_azure' OR agent.user_cloud_authorized_at IS NULL
 OR agent.backend_metadata ? 'erasure' OR public.azure_vm_power_pending(agent.backend_metadata) IS TRUE
 OR EXISTS(SELECT 1 FROM personal_agent_deletion_tombstones WHERE hushh_id=agent.hushh_id)
 OR EXISTS(SELECT 1 FROM account_deletion_tombstones WHERE cleanup_intent_kind='full_account'
   AND user_id_hash='sha256:'||encode(sha256(convert_to(agent.user_id,'UTF8')),'hex'))
 OR EXISTS(SELECT 1 FROM pod_migration_jobs WHERE user_id=agent.user_id)
 OR EXISTS(SELECT 1 FROM personal_agent_standby_placements WHERE user_id=agent.user_id)
 OR agent.user_cloud_tenant_id IS DISTINCT FROM intent->>'tenantId'
 OR agent.user_cloud_subscription_id IS DISTINCT FROM intent->>'subscriptionId'
 OR agent.user_cloud_resource_group IS DISTINCT FROM intent->>'resourceGroup'
 OR agent.user_cloud_region IS DISTINCT FROM intent->>'location'
 OR (approval->>'status' IN ('approved','scheduled','updating','blocked')) IS NOT TRUE
 OR approval->>'targetImage' IS DISTINCT FROM intent->>'sourceImage'
 OR EXISTS(SELECT 1 FROM unnest(ARRAY['operationId','releaseId','idempotencyKey']) k
   WHERE approval->k IS DISTINCT FROM intent->k)
 OR intent->'binding' IS DISTINCT FROM public.azure_vm_upgrade_registry_binding(to_jsonb(agent))
 OR public.valid_byoc_azure_vm_upgrade_intent(agent.user_id,intent->>'jobId',job.project_id,agent.hushh_id,intent) IS NOT TRUE
 OR intent->>'attemptId' IS DISTINCT FROM encode(sha256(convert_to(agent.backend_metadata->>'upgradeLease','UTF8')),'hex')
 OR public.azure_vm_upgrade_dispatch_settled(intent,job.stages) IS NOT TRUE
 THEN RETURN NULL; END IF;
 RETURN intent;
END;
$function$
$object$;
 ELSIF encode(sha256(convert_to(actual,'UTF8')),'hex') NOT IN ('377888bbee1af4ad57aed86099d6b9c8536eee21aae1ae3bc763ae4d4baa772b') THEN
  RAISE EXCEPTION 'Unqualified schema drift: azure_vm_upgrade_recovery_intent';
 END IF;
END
$object_guard$;

REVOKE ALL ON FUNCTION public."azure_vm_upgrade_recovery_intent"(personal_agent_registry) FROM PUBLIC;

DO $pod_414$
BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN GRANT EXECUTE ON FUNCTION public."azure_vm_upgrade_recovery_intent"(personal_agent_registry) TO service_role; END IF;
END
$pod_414$;

DO $object_guard$
DECLARE actual text;
BEGIN
 SELECT definition INTO actual FROM (SELECT pg_get_functiondef(p.oid) definition FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='azure_vm_upgrade_registry_binding' AND pg_get_function_identity_arguments(p.oid)='agent jsonb') observed;
 IF actual IS NULL THEN
  EXECUTE $object$CREATE OR REPLACE FUNCTION public.azure_vm_upgrade_registry_binding(agent jsonb)
 RETURNS jsonb
 LANGUAGE sql
 IMMUTABLE
AS $function$
 SELECT jsonb_build_object(
  'user_id',agent->'user_id','hushh_id',agent->'hushh_id','backend',agent->'backend',
  'external_agent_id',agent->'external_agent_id','deployment_target',agent->'deployment_target',
  'pod_pubkey',agent->'pod_pubkey','pod_key_id',agent->'pod_key_id',
  'model_credential_mode',agent->'model_credential_mode','placement_epoch',agent->'placement_epoch',
  'pod_signing_key_id',agent->'pod_signing_key_id','pod_signing_pubkey',agent->'pod_signing_pubkey',
  'serviceUid',agent->'backend_metadata'->'serviceUid',
  'setupNonce',agent->'backend_metadata'->'setupNonce',
  'runtime_principal_id',agent->'backend_metadata'->'runtime_principal_id',
  'runtime_client_id',agent->'backend_metadata'->'runtime_client_id',
  'image',agent->'backend_metadata'->'image','image_digest',agent->'backend_metadata'->'image_digest',
  'hostKind',agent->'backend_metadata'->'hostKind','vmHost',agent->'backend_metadata'->'vmHost',
  'url',agent->'backend_metadata'->'url',
  'vmConfigurationSha256',agent->'backend_metadata'->'vmConfigurationSha256',
  'vmUpdateModuleSha256',agent->'backend_metadata'->'vmUpdateModuleSha256',
  'vmPower',CASE WHEN jsonb_typeof(agent->'backend_metadata'->'vmPower')='object' THEN
   jsonb_build_object('operationId',agent->'backend_metadata'->'vmPower'->'operationId',
    'phase',agent->'backend_metadata'->'vmPower'->'phase',
    'binding',agent->'backend_metadata'->'vmPower'->'binding') ELSE 'null'::jsonb END);
$function$
$object$;
 ELSIF encode(sha256(convert_to(actual,'UTF8')),'hex') NOT IN ('c5f46940d6adb3bd94a978097b5354c0584fe0b29af4588eb62e2e12f5ba8ae2') THEN
  RAISE EXCEPTION 'Unqualified schema drift: azure_vm_upgrade_registry_binding';
 END IF;
END
$object_guard$;

REVOKE ALL ON FUNCTION public."azure_vm_upgrade_registry_binding"(jsonb) FROM PUBLIC;

DO $pod_414$
BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN GRANT EXECUTE ON FUNCTION public."azure_vm_upgrade_registry_binding"(jsonb) TO service_role; END IF;
END
$pod_414$;

DO $object_guard$
DECLARE actual text;
BEGIN
 SELECT definition INTO actual FROM (SELECT pg_get_functiondef(p.oid) definition FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='begin_azure_erasure_worker' AND pg_get_function_identity_arguments(p.oid)='owner_id text, attempt_id text, execution_id text') observed;
 IF actual IS NULL THEN
  EXECUTE $object$CREATE OR REPLACE FUNCTION public.begin_azure_erasure_worker(owner_id text, attempt_id text, execution_id text)
 RETURNS boolean
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE agent public.personal_agent_registry%ROWTYPE; r jsonb; state jsonb; acquired boolean;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended(owner_id,171));
 PERFORM pg_advisory_xact_lock(hashtextextended(owner_id,198));
 IF public.byoc_azure_worker_session_held(owner_id) IS TRUE THEN RETURN false; END IF;
 acquired:=pg_try_advisory_lock(hashtextextended(owner_id,206));
 IF NOT acquired THEN RETURN false; END IF;
 SELECT * INTO agent FROM public.personal_agent_registry WHERE user_id=owner_id FOR UPDATE;
 r:=agent.backend_metadata->'erasure'; state:=r->'azureTeardown';
 state:=state||jsonb_build_object('worker',jsonb_build_object('executionId',execution_id,
  'backendPid',pg_backend_pid(),'approvalIndex',jsonb_array_length(state->'approvals')-1));
 IF public.retain_azure_erasure_state(owner_id,attempt_id,r,state) IS NOT TRUE THEN
  PERFORM pg_advisory_unlock(hashtextextended(owner_id,206)); RETURN false;
 END IF;
 RETURN true;
EXCEPTION WHEN OTHERS THEN
 -- Closing the dedicated connection is also mandatory for the caller.
 IF acquired THEN PERFORM pg_advisory_unlock(hashtextextended(owner_id,206)); END IF;
 RAISE;
END;
$function$
$object$;
 ELSIF encode(sha256(convert_to(actual,'UTF8')),'hex') NOT IN ('3bca3fd98eb3c604b542d8e6f476d6d627e7ec50e23166446d096dd42b04ee9c','64cb6b714c5a63a37e64db0c5ff602b7bfaa4cbe17225486a9dc5eede179be8e') THEN
  RAISE EXCEPTION 'Unqualified schema drift: begin_azure_erasure_worker';
 END IF;
END
$object_guard$;

REVOKE ALL ON FUNCTION public."begin_azure_erasure_worker"(text, text, text) FROM PUBLIC;

DO $pod_414$
BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN GRANT EXECUTE ON FUNCTION public."begin_azure_erasure_worker"(text, text, text) TO service_role; END IF;
END
$pod_414$;

DO $object_guard$
DECLARE actual text;
BEGIN
 SELECT definition INTO actual FROM (SELECT pg_get_functiondef(p.oid) definition FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='begin_byoc_azure_worker' AND pg_get_function_identity_arguments(p.oid)='owner_id text, expected_job text, execution_id text') observed;
 IF actual IS NULL THEN
  EXECUTE $object$CREATE OR REPLACE FUNCTION public.begin_byoc_azure_worker(owner_id text, expected_job text, execution_id text)
 RETURNS boolean
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE result boolean;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended(owner_id,171));
 PERFORM pg_advisory_xact_lock(hashtextextended(owner_id,198));
 IF NOT pg_try_advisory_lock(hashtextextended(owner_id,206)) THEN RETURN false; END IF;
 result:=public.retain_byoc_azure_worker_event(owner_id,expected_job,jsonb_build_object(
   'stage','azure_worker_started','jobId',expected_job,'executionId',execution_id,
   'backendPid',pg_backend_pid()));
 IF result IS NOT TRUE THEN PERFORM pg_advisory_unlock(hashtextextended(owner_id,206)); END IF;
 RETURN result;
EXCEPTION WHEN OTHERS THEN
 PERFORM pg_advisory_unlock(hashtextextended(owner_id,206)); RAISE;
END;
$function$
$object$;
 ELSIF encode(sha256(convert_to(actual,'UTF8')),'hex') NOT IN ('90fb0744e771aa5abc5582da509c8ed4085ccd1ec360567b82d7c8f2326817d2') THEN
  RAISE EXCEPTION 'Unqualified schema drift: begin_byoc_azure_worker';
 END IF;
END
$object_guard$;

REVOKE ALL ON FUNCTION public."begin_byoc_azure_worker"(text, text, text) FROM PUBLIC;

DO $pod_414$
BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN GRANT EXECUTE ON FUNCTION public."begin_byoc_azure_worker"(text, text, text) TO service_role; END IF;
END
$pod_414$;

DO $object_guard$
DECLARE actual text;
BEGIN
 SELECT definition INTO actual FROM (SELECT pg_get_functiondef(p.oid) definition FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='begin_byoc_azure_worker' AND pg_get_function_identity_arguments(p.oid)='owner_id text, expected_job text, execution_id text, intent jsonb') observed;
 IF actual IS NULL THEN
  EXECUTE $object$CREATE OR REPLACE FUNCTION public.begin_byoc_azure_worker(owner_id text, expected_job text, execution_id text, intent jsonb)
 RETURNS boolean
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE result boolean;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended(owner_id,171));
 PERFORM pg_advisory_xact_lock(hashtextextended(owner_id,198));
 IF NOT pg_try_advisory_lock(hashtextextended(owner_id,206)) THEN RETURN false; END IF;
 result:=intent->'version' IN ('2'::jsonb,'3'::jsonb) AND
   public.retain_byoc_azure_setup_intent(owner_id,expected_job,intent);
 IF result IS TRUE THEN
   result:=public.retain_byoc_azure_worker_event(owner_id,expected_job,jsonb_build_object(
    'stage','azure_worker_started','jobId',expected_job,'executionId',execution_id,
    'backendPid',pg_backend_pid()));
 END IF;
 IF result IS NOT TRUE THEN PERFORM pg_advisory_unlock(hashtextextended(owner_id,206)); END IF;
 RETURN result;
EXCEPTION WHEN OTHERS THEN
 PERFORM pg_advisory_unlock(hashtextextended(owner_id,206)); RAISE;
END $function$
$object$;
 ELSIF encode(sha256(convert_to(actual,'UTF8')),'hex') NOT IN ('bf1763eb7dde800f772b34195f371fff87876a1cd2b07deb384b918516f51023') THEN
  RAISE EXCEPTION 'Unqualified schema drift: begin_byoc_azure_worker';
 END IF;
END
$object_guard$;

REVOKE ALL ON FUNCTION public."begin_byoc_azure_worker"(text, text, text, jsonb) FROM PUBLIC;

DO $pod_414$
BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN GRANT EXECUTE ON FUNCTION public."begin_byoc_azure_worker"(text, text, text, jsonb) TO service_role; END IF;
END
$pod_414$;

DO $object_guard$
DECLARE actual text;
BEGIN
 SELECT definition INTO actual FROM (SELECT pg_get_functiondef(p.oid) definition FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='block_unattempted_azure_vm_upgrade' AND pg_get_function_identity_arguments(p.oid)='owner_id text, job_id text, operation_id text, attempt_id text, expected_binding jsonb') observed;
 IF actual IS NULL THEN
  EXECUTE $object$CREATE OR REPLACE FUNCTION public.block_unattempted_azure_vm_upgrade(owner_id text, job_id text, operation_id text, attempt_id text, expected_binding jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE agent public.personal_agent_registry; job public.byoc_setup_jobs; m jsonb; approval jsonb;
BEGIN
 IF NOT pg_try_advisory_xact_lock(hashtextextended(owner_id,171))
 OR NOT pg_try_advisory_xact_lock(hashtextextended(owner_id,198))
 OR NOT pg_try_advisory_xact_lock(hashtextextended(owner_id,206)) THEN RETURN NULL; END IF;
 SELECT * INTO agent FROM personal_agent_registry WHERE user_id=owner_id FOR UPDATE;
 SELECT * INTO job FROM byoc_setup_jobs WHERE user_id=owner_id FOR UPDATE;
 m:=agent.backend_metadata; approval:=m->'upgradeApproval';
 IF agent.status IS DISTINCT FROM 'provisioned' OR agent.backend IS DISTINCT FROM 'user_azure'
 OR agent.user_cloud_authorized_at IS NULL
 OR agent.deployment_target IS DISTINCT FROM 'user_azure' OR m->>'hostKind' IS DISTINCT FROM 'azure_vm'
 OR public.azure_vm_upgrade_registry_binding(to_jsonb(agent)) IS DISTINCT FROM expected_binding
 OR m ? 'erasure' OR public.azure_vm_power_pending(m) IS TRUE
 OR EXISTS(SELECT 1 FROM personal_agent_deletion_tombstones WHERE hushh_id=agent.hushh_id)
 OR EXISTS(SELECT 1 FROM account_deletion_tombstones WHERE cleanup_intent_kind='full_account'
   AND user_id_hash='sha256:'||encode(sha256(convert_to(owner_id,'UTF8')),'hex'))
 OR EXISTS(SELECT 1 FROM pod_migration_jobs WHERE user_id=owner_id)
 OR EXISTS(SELECT 1 FROM personal_agent_standby_placements WHERE user_id=owner_id)
 OR job.job_id IS DISTINCT FROM job_id OR job.status IS DISTINCT FROM 'running'
 OR jsonb_typeof(job.stages) IS DISTINCT FROM 'array'
 OR approval->>'operationId' IS DISTINCT FROM operation_id
 OR approval->>'ownerId' IS DISTINCT FROM owner_id OR approval->>'hushhId' IS DISTINCT FROM agent.hushh_id
 OR (approval->>'status' IN ('approved','scheduled','updating','blocked')) IS NOT TRUE
 OR coalesce(m->>'upgradeLease','')=''
 OR encode(sha256(convert_to(m->>'upgradeLease','UTF8')),'hex') IS DISTINCT FROM attempt_id
 -- Unknown older work cannot be declared harmless. The current job, and every
 -- prior use of this operation, must have no possibly-dispatched request.
 OR EXISTS(SELECT 1 FROM jsonb_array_elements(job.stages) r WHERE r->>'stage'='azure_provider_request'
   AND (NOT EXISTS(SELECT 1 FROM jsonb_array_elements(job.stages) t
     WHERE t->>'stage'='azure_provider_terminal' AND t->>'requestId'=r->>'requestId')
    OR ((r->>'jobId'=job_id OR EXISTS(SELECT 1 FROM jsonb_array_elements(job.stages) i
      WHERE i->>'stage' IN ('azure_setup_intent','azure_setup_prior_intent')
      AND i->'intent'->>'operationId'=operation_id AND i->'intent'->>'jobId'=r->>'jobId'))
     AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(job.stages) t
       WHERE t->>'stage'='azure_provider_terminal' AND t->>'requestId'=r->>'requestId'
       AND t->>'outcome'='not_dispatched'))))
 THEN RETURN NULL; END IF;
 UPDATE personal_agent_registry SET backend_metadata=jsonb_set(m,'{upgradeApproval}',
   approval||jsonb_build_object('status','blocked','operationState','blocked',
    'presentationPhase','blocked','failureCode','VM_UPDATE_NOT_DISPATCHED'))
 WHERE user_id=owner_id RETURNING * INTO agent;
 RETURN to_jsonb(agent);
END;
$function$
$object$;
 ELSIF encode(sha256(convert_to(actual,'UTF8')),'hex') NOT IN ('0e47457cf573297be4c86a2cca49c41b005261728523da08e07190ad21d05fcb') THEN
  RAISE EXCEPTION 'Unqualified schema drift: block_unattempted_azure_vm_upgrade';
 END IF;
END
$object_guard$;

REVOKE ALL ON FUNCTION public."block_unattempted_azure_vm_upgrade"(text, text, text, text, jsonb) FROM PUBLIC;

DO $pod_414$
BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN GRANT EXECUTE ON FUNCTION public."block_unattempted_azure_vm_upgrade"(text, text, text, text, jsonb) TO service_role; END IF;
END
$pod_414$;

DO $object_guard$
DECLARE actual text;
BEGIN
 SELECT definition INTO actual FROM (SELECT pg_get_functiondef(p.oid) definition FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='browser_update_admission_ready' AND pg_get_function_identity_arguments(p.oid)='') observed;
 IF actual IS NULL THEN
  EXECUTE $object$CREATE OR REPLACE FUNCTION public.browser_update_admission_ready()
 RETURNS boolean
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
 SELECT to_regprocedure('public.valid_gcp_browser_update_approval(jsonb,jsonb)') IS NOT NULL
 AND position('valid_gcp_browser_update_approval' IN pg_get_functiondef(
   'public.valid_personal_agent_notification_checkpoint(jsonb,jsonb,jsonb)'::regprocedure))>0
 AND public.operator_notification_custody_ready();
$function$
$object$;
 ELSIF encode(sha256(convert_to(actual,'UTF8')),'hex') NOT IN ('3e77d3ae416ae4056d1677c0bd6d467c0bed20c4b8205cf3fad78301365a9064') THEN
  RAISE EXCEPTION 'Unqualified schema drift: browser_update_admission_ready';
 END IF;
END
$object_guard$;

REVOKE ALL ON FUNCTION public."browser_update_admission_ready"() FROM PUBLIC;

DO $pod_414$
BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN GRANT EXECUTE ON FUNCTION public."browser_update_admission_ready"() TO service_role; END IF;
END
$pod_414$;

DO $object_guard$
DECLARE actual text;
BEGIN
 SELECT definition INTO actual FROM (SELECT pg_get_functiondef(p.oid) definition FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='byoc_azure_files_request_admitted' AND pg_get_function_identity_arguments(p.oid)='owner_id text, event jsonb') observed;
 IF actual IS NULL THEN
  EXECUTE $object$CREATE OR REPLACE FUNCTION public.byoc_azure_files_request_admitted(owner_id text, event jsonb)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public'
AS $function$
DECLARE agent public.personal_agent_registry%ROWTYPE; metadata jsonb; checkpoint jsonb;
 candidate jsonb; operation jsonb;
BEGIN
 IF to_regprocedure('public.valid_erasure_azure_files_upgrade_observation(jsonb,jsonb)') IS NULL
 THEN RETURN false; END IF;
 SELECT * INTO agent FROM public.personal_agent_registry WHERE user_id=owner_id;
 metadata:=agent.backend_metadata; checkpoint:=metadata->'filesUpgradeCheckpoint';
 IF jsonb_typeof(checkpoint->'completed') IS DISTINCT FROM 'array'
  OR jsonb_typeof(metadata->'azureFilesInventory'->'plannedOperations') IS DISTINCT FROM 'array'
 THEN RETURN false; END IF;
 SELECT x INTO operation FROM jsonb_array_elements(metadata->'azureFilesInventory'->'plannedOperations') x
  WHERE x->>'step'=checkpoint->>'step';
 IF operation IS NULL OR event->>'method' IS DISTINCT FROM 'PUT'
  OR event->>'path' IS DISTINCT FROM operation->>'path'
  OR event->>'apiVersion' IS DISTINCT FROM (CASE operation->>'api'
     WHEN 'storage' THEN '2023-05-01' WHEN 'authorization' THEN '2022-04-01' END)
 THEN RETURN false; END IF;
 -- Validate the admitted prefix and planned operation without asserting a
 -- provider observation: this synthetic failure is never retained as a receipt.
 candidate:=jsonb_set(jsonb_set(checkpoint,'{phase}','"observed"'::jsonb),'{completed}',
  (checkpoint->'completed')||jsonb_build_array(jsonb_build_object(
   'step',checkpoint->>'step','ok',false,'status',0)));
 RETURN public.valid_erasure_azure_files_upgrade_observation(jsonb_build_object(
  'ownerId',owner_id,'hushhId',agent.hushh_id,'registrySnapshot',to_jsonb(agent)),candidate);
END $function$
$object$;
 ELSIF encode(sha256(convert_to(actual,'UTF8')),'hex') NOT IN ('6de6be8631dfc22bfa2afadb2c906d588f2efcac618d66973ee23336555414d0') THEN
  RAISE EXCEPTION 'Unqualified schema drift: byoc_azure_files_request_admitted';
 END IF;
END
$object_guard$;

REVOKE ALL ON FUNCTION public."byoc_azure_files_request_admitted"(text, jsonb) FROM PUBLIC;

DO $pod_414$
BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN GRANT EXECUTE ON FUNCTION public."byoc_azure_files_request_admitted"(text, jsonb) TO service_role; END IF;
END
$pod_414$;

DO $object_guard$
DECLARE actual text;
BEGIN
 SELECT definition INTO actual FROM (SELECT pg_get_functiondef(p.oid) definition FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='byoc_azure_intent_admitted' AND pg_get_function_identity_arguments(p.oid)='agent personal_agent_registry, job byoc_setup_jobs, intent jsonb, allow_unbound boolean') observed;
 IF actual IS NULL THEN
  EXECUTE $object$CREATE OR REPLACE FUNCTION public.byoc_azure_intent_admitted(agent personal_agent_registry, job byoc_setup_jobs, intent jsonb, allow_unbound boolean DEFAULT false)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public'
AS $function$
DECLARE metadata jsonb:=coalesce(agent.backend_metadata,'{}'::jsonb);
 approval jsonb:=metadata->'upgradeApproval'; binding jsonb;
BEGIN
 IF intent->'version'='3'::jsonb THEN
  RETURN public.byoc_azure_vm_upgrade_admitted(agent,job,intent);
 END IF;
 IF job.user_id IS DISTINCT FROM agent.user_id OR job.status IS DISTINCT FROM 'running'
  OR metadata ? 'erasure' OR jsonb_typeof(job.stages) IS DISTINCT FROM 'array'
 THEN RETURN false; END IF;
 IF agent.status IN ('pending','unprovisioned','logical') AND nullif(agent.backend,'') IS NULL
  AND nullif(agent.external_agent_id,'') IS NULL AND nullif(agent.user_cloud_project,'') IS NULL
 THEN RETURN (allow_unbound AND intent IS NULL) OR (intent->'version'='1'::jsonb AND
   public.valid_byoc_azure_setup_intent(agent.user_id,job.job_id,job.project_id,agent.hushh_id,intent));
 END IF;
 IF intent->'version' IS DISTINCT FROM '2'::jsonb
  OR public.valid_byoc_azure_setup_intent(agent.user_id,job.job_id,job.project_id,agent.hushh_id,intent) IS NOT TRUE
  OR agent.deployment_target IS DISTINCT FROM 'user_azure' OR agent.backend IS DISTINCT FROM 'user_azure'
  OR nullif(agent.user_cloud_project,'') IS NOT NULL
  OR agent.user_cloud_tenant_id IS DISTINCT FROM intent->>'tenantId'
  OR agent.user_cloud_subscription_id IS DISTINCT FROM intent->>'subscriptionId'
  OR agent.user_cloud_resource_group IS DISTINCT FROM intent->>'resourceGroup'
  OR agent.user_cloud_region IS DISTINCT FROM intent->>'location'
  OR metadata->>'setupNonce' IS DISTINCT FROM intent->>'setupNonce'
  OR EXISTS(SELECT 1 FROM unnest(ARRAY['serviceUid','runtime_principal_id','runtime_client_id']) k
    WHERE coalesce(metadata->>k,'')='')
  OR coalesce(agent.pod_pubkey,'')='' OR coalesce(agent.pod_key_id,'')=''
 THEN RETURN false; END IF;
 binding:=jsonb_build_object('user_id',agent.user_id,'hushh_id',agent.hushh_id,
  'backend',agent.backend,'external_agent_id',agent.external_agent_id,
  'deployment_target',agent.deployment_target,'pod_pubkey',agent.pod_pubkey,
  'pod_key_id',agent.pod_key_id,'model_credential_mode',agent.model_credential_mode,
  'serviceUid',metadata->'serviceUid','setupNonce',metadata->'setupNonce','image',metadata->'image',
  'runtime_principal_id',metadata->'runtime_principal_id','runtime_client_id',metadata->'runtime_client_id');
 IF intent->'binding' IS DISTINCT FROM binding THEN RETURN false; END IF;
 IF intent->>'kind'='rebuild' THEN
   RETURN agent.status IN ('provisioned','needs_reinit') AND coalesce(metadata->>'upgradeLease','')='';
 END IF;
 RETURN agent.status='provisioned' AND coalesce(metadata->>'upgradeLease','')<>''
  AND intent->>'attemptId'=encode(sha256(convert_to(metadata->>'upgradeLease','UTF8')),'hex')
  AND (approval->'version'='1'::jsonb OR public.valid_azure_browser_update_approval(to_jsonb(agent),approval))
  AND approval->>'ownerId'=agent.user_id
  AND approval->>'hushhId'=agent.hushh_id AND approval->>'podIncarnation'=metadata->>'serviceUid'
  AND approval->>'status' IN ('approved','scheduled','updating')
  AND approval->>'targetImage'=intent->>'sourceImage'
  AND approval->>'operationId'=intent->>'operationId' AND approval->>'releaseId'=intent->>'releaseId'
  AND approval->>'idempotencyKey'=intent->>'idempotencyKey'
  AND coalesce(approval->'capabilityPlanDigest','null'::jsonb)=intent->'capabilityPlanDigest';
END $function$
$object$;
 ELSIF encode(sha256(convert_to(actual,'UTF8')),'hex') NOT IN ('cc2276bfd52d43d74b69954e953ee68d26ba7c0c213ea151b6d0853964a360c1') THEN
  RAISE EXCEPTION 'Unqualified schema drift: byoc_azure_intent_admitted';
 END IF;
END
$object_guard$;

REVOKE ALL ON FUNCTION public."byoc_azure_intent_admitted"(personal_agent_registry, byoc_setup_jobs, jsonb, boolean) FROM PUBLIC;

DO $pod_414$
BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN GRANT EXECUTE ON FUNCTION public."byoc_azure_intent_admitted"(personal_agent_registry, byoc_setup_jobs, jsonb, boolean) TO service_role; END IF;
END
$pod_414$;

DO $object_guard$
DECLARE actual text;
BEGIN
 SELECT definition INTO actual FROM (SELECT pg_get_functiondef(p.oid) definition FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='byoc_azure_live_worker_admitted' AND pg_get_function_identity_arguments(p.oid)='owner_id text, expected_job text, allow_unbound boolean') observed;
 IF actual IS NULL THEN
  EXECUTE $object$CREATE OR REPLACE FUNCTION public.byoc_azure_live_worker_admitted(owner_id text, expected_job text, allow_unbound boolean DEFAULT false)
 RETURNS boolean
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
 SELECT coalesce((SELECT public.byoc_azure_intent_admitted(r,j,
   (SELECT x->'intent' FROM jsonb_array_elements(j.stages) x WHERE x->>'stage'='azure_setup_intent'),
   allow_unbound)
 FROM public.personal_agent_registry r JOIN public.byoc_setup_jobs j ON j.user_id=r.user_id
 WHERE r.user_id=owner_id AND j.job_id=expected_job),false);
$function$
$object$;
 ELSIF encode(sha256(convert_to(actual,'UTF8')),'hex') NOT IN ('7117bed09cf62d3fa1531d46bcd322fd16af73ef55f8fcf23a3955453929fe45') THEN
  RAISE EXCEPTION 'Unqualified schema drift: byoc_azure_live_worker_admitted';
 END IF;
END
$object_guard$;

REVOKE ALL ON FUNCTION public."byoc_azure_live_worker_admitted"(text, text, boolean) FROM PUBLIC;

DO $pod_414$
BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN GRANT EXECUTE ON FUNCTION public."byoc_azure_live_worker_admitted"(text, text, boolean) TO service_role; END IF;
END
$pod_414$;

DO $object_guard$
DECLARE actual text;
BEGIN
 SELECT definition INTO actual FROM (SELECT pg_get_functiondef(p.oid) definition FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='byoc_azure_setup_guards_ready' AND pg_get_function_identity_arguments(p.oid)='') observed;
 IF actual IS NULL THEN
  EXECUTE $object$CREATE OR REPLACE FUNCTION public.byoc_azure_setup_guards_ready()
 RETURNS boolean
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
 SELECT count(*)=2 FROM pg_trigger WHERE tgenabled IN ('O','A') AND tgnargs=0
 AND tgqual IS NULL AND (
   (tgrelid='public.byoc_setup_jobs'::regclass AND tgname='zw_byoc_azure_erasure'
    AND tgfoid='public.guard_byoc_azure_erasure_job()'::regprocedure AND tgtype=31)
   OR (tgrelid='public.personal_agent_registry'::regclass
    AND tgname='zz_personal_agent_erasure_registry'
    AND tgfoid='public.guard_personal_agent_erasure_registry()'::regprocedure AND tgtype=27));
$function$
$object$;
 ELSIF encode(sha256(convert_to(actual,'UTF8')),'hex') NOT IN ('072afb19f71f784d0b8b2b1390f46a4c335ff3781dbdf46e191103dcbed68891') THEN
  RAISE EXCEPTION 'Unqualified schema drift: byoc_azure_setup_guards_ready';
 END IF;
END
$object_guard$;

REVOKE ALL ON FUNCTION public."byoc_azure_setup_guards_ready"() FROM PUBLIC;

DO $pod_414$
BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN GRANT EXECUTE ON FUNCTION public."byoc_azure_setup_guards_ready"() TO service_role; END IF;
END
$pod_414$;

DO $object_guard$
DECLARE actual text;
BEGIN
 SELECT definition INTO actual FROM (SELECT pg_get_functiondef(p.oid) definition FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='byoc_azure_vm_upgrade_admitted' AND pg_get_function_identity_arguments(p.oid)='agent personal_agent_registry, job byoc_setup_jobs, intent jsonb') observed;
 IF actual IS NULL THEN
  EXECUTE $object$CREATE OR REPLACE FUNCTION public.byoc_azure_vm_upgrade_admitted(agent personal_agent_registry, job byoc_setup_jobs, intent jsonb)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public'
AS $function$
DECLARE metadata jsonb:=agent.backend_metadata; approval jsonb:=metadata->'upgradeApproval';
 cursor_value jsonb:=approval->'handoffCommittedCursor'; marker jsonb:=approval->'handoffIdleRecord';
 host jsonb:=metadata->'vmHost'; installation jsonb:=host->'installation';
BEGIN
 IF jsonb_typeof(job.stages) IS DISTINCT FROM 'array' THEN RETURN false; END IF;
 IF agent.user_id IS DISTINCT FROM job.user_id OR job.status IS DISTINCT FROM 'running'
 OR agent.user_cloud_authorized_at IS NULL
 OR agent.status IS DISTINCT FROM 'provisioned' OR agent.backend IS DISTINCT FROM 'user_azure'
 OR agent.deployment_target IS DISTINCT FROM 'user_azure'
 OR nullif(agent.user_cloud_project,'') IS NOT NULL OR metadata ? 'erasure'
 OR public.valid_byoc_azure_vm_upgrade_intent(agent.user_id,job.job_id,job.project_id,
   agent.hushh_id,intent) IS NOT TRUE
 OR intent->'binding' IS DISTINCT FROM public.azure_vm_upgrade_registry_binding(to_jsonb(agent))
 OR agent.user_cloud_tenant_id IS DISTINCT FROM intent->>'tenantId'
 OR agent.user_cloud_subscription_id IS DISTINCT FROM intent->>'subscriptionId'
 OR agent.user_cloud_resource_group IS DISTINCT FROM intent->>'resourceGroup'
 OR agent.user_cloud_region IS DISTINCT FROM intent->>'location'
 OR host->>'location' IS DISTINCT FROM agent.user_cloud_region
 OR metadata->>'setupNonce' IS DISTINCT FROM intent->>'setupNonce'
 OR host->>'principalId' IS DISTINCT FROM metadata->>'runtime_principal_id'
 OR installation->>'client_id' IS DISTINCT FROM metadata->>'runtime_client_id'
 OR EXISTS(SELECT 1 FROM unnest(ARRAY['serviceUid','runtime_principal_id','runtime_client_id']) k
   WHERE coalesce(metadata->>k,'')='')
 OR coalesce(agent.pod_key_id,'')='' OR coalesce(agent.pod_pubkey,'')=''
 OR coalesce(agent.pod_signing_key_id,'')='' OR coalesce(agent.pod_signing_pubkey,'')=''
 OR jsonb_typeof(to_jsonb(agent.placement_epoch)) IS DISTINCT FROM 'number' OR agent.placement_epoch<0
 OR public.azure_vm_power_pending(metadata) IS TRUE
 -- A setup retry may archive a completed journal, but cannot install this
 -- durable owner operation again under a new job/worker identifier.
 OR EXISTS(SELECT 1 FROM jsonb_array_elements(job.stages) h
   WHERE h->>'stage' IN ('azure_setup_intent','azure_setup_prior_intent')
   AND h->'intent'->'version'='3'::jsonb
   AND h->'intent'->>'operationId'=intent->>'operationId'
   AND h->'intent'->>'jobId' IS DISTINCT FROM job.job_id)
 OR EXISTS(SELECT 1 FROM personal_agent_deletion_tombstones WHERE hushh_id=agent.hushh_id)
 OR EXISTS(SELECT 1 FROM account_deletion_tombstones WHERE cleanup_intent_kind='full_account'
   AND user_id_hash='sha256:'||encode(sha256(convert_to(agent.user_id,'UTF8')),'hex'))
 OR EXISTS(SELECT 1 FROM pod_migration_jobs WHERE user_id=agent.user_id)
 OR EXISTS(SELECT 1 FROM personal_agent_standby_placements WHERE user_id=agent.user_id)
 OR coalesce(metadata->>'upgradeLease','')=''
 OR intent->>'attemptId' IS DISTINCT FROM encode(sha256(convert_to(metadata->>'upgradeLease','UTF8')),'hex')
 OR approval->'version' IS DISTINCT FROM '1'::jsonb
 OR approval->>'ownerId' IS DISTINCT FROM agent.user_id OR approval->>'hushhId' IS DISTINCT FROM agent.hushh_id
 OR approval->>'podIncarnation' IS DISTINCT FROM metadata->>'serviceUid'
 OR (approval->>'status' IN ('approved','scheduled','updating')) IS NOT TRUE
 OR approval->>'targetImage' IS DISTINCT FROM intent->>'sourceImage'
 OR approval->>'operationId' IS DISTINCT FROM intent->>'operationId'
 OR approval->>'releaseId' IS DISTINCT FROM intent->>'releaseId'
 OR approval->>'idempotencyKey' IS DISTINCT FROM intent->>'idempotencyKey'
 OR coalesce(approval->'capabilityPlanDigest','null'::jsonb)<>'null'::jsonb
 OR approval->>'handoffIncarnation' IS DISTINCT FROM metadata->>'serviceUid'
 OR (approval->>'handoffRuntimeEpoch' ~ '^[A-Za-z0-9_-]+$') IS NOT TRUE
 OR length(approval->>'handoffRuntimeEpoch')>256
 OR marker IS DISTINCT FROM intent->'idleRecord'
 OR public.valid_pod_upgrade_cursor(cursor_value) IS NOT TRUE
 OR public.valid_pod_upgrade_cursor(marker) IS NOT TRUE
 THEN RETURN false; END IF;
 RETURN (marker->>'seq')::numeric>(cursor_value->>'seq')::numeric
  AND approval->>'handoffCommittedState'=encode(sha256(convert_to(
    (intent->>'operationId')||'|'||(approval->>'handoffIncarnation')||'|'||
    (cursor_value->>'seq')||'|'||(cursor_value->>'sha')||'|active=0','UTF8')),'hex');
END;
$function$
$object$;
 ELSIF encode(sha256(convert_to(actual,'UTF8')),'hex') NOT IN ('782d309e7c7298c20088bd418f9e2e7618723d3f404d2c8a61be39cfcbe28cab') THEN
  RAISE EXCEPTION 'Unqualified schema drift: byoc_azure_vm_upgrade_admitted';
 END IF;
END
$object_guard$;

REVOKE ALL ON FUNCTION public."byoc_azure_vm_upgrade_admitted"(personal_agent_registry, byoc_setup_jobs, jsonb) FROM PUBLIC;

DO $pod_414$
BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN GRANT EXECUTE ON FUNCTION public."byoc_azure_vm_upgrade_admitted"(personal_agent_registry, byoc_setup_jobs, jsonb) TO service_role; END IF;
END
$pod_414$;

DO $object_guard$
DECLARE actual text;
BEGIN
 SELECT definition INTO actual FROM (SELECT pg_get_functiondef(p.oid) definition FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='byoc_azure_vm_upgrade_request_ready' AND pg_get_function_identity_arguments(p.oid)='intent jsonb, event jsonb, history jsonb') observed;
 IF actual IS NULL THEN
  EXECUTE $object$CREATE OR REPLACE FUNCTION public.byoc_azure_vm_upgrade_request_ready(intent jsonb, event jsonb, history jsonb)
 RETURNS boolean
 LANGUAGE plpgsql
 IMMUTABLE
 SET search_path TO 'public'
AS $function$
DECLARE call jsonb; previous jsonb; index_value integer;
BEGIN
 SELECT value,ordinality::integer-1 INTO call,index_value
 FROM jsonb_array_elements(intent->'allowedRequests') WITH ORDINALITY
 WHERE value=event-ARRAY['stage','jobId','executionId','requestId'];
 IF call IS NULL THEN RETURN false; END IF;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(history) r
   WHERE r->>'stage'='azure_provider_request' AND r->>'jobId'=intent->>'jobId'
   AND r->>'purpose'=call->>'purpose'
   AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(history) t
     WHERE t->>'stage'='azure_provider_terminal' AND t->>'requestId'=r->>'requestId'
     AND t->>'outcome'='not_dispatched')) THEN RETURN false; END IF;
 IF index_value=0 THEN RETURN true; END IF;
 FOR n IN 0..index_value-1 LOOP
  previous:=intent->'allowedRequests'->n;
  IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(history) r
    JOIN jsonb_array_elements(history) t ON t->>'requestId'=r->>'requestId'
    WHERE r->>'stage'='azure_provider_request' AND r->>'jobId'=intent->>'jobId'
    AND r->>'purpose'=previous->>'purpose'
    AND t->>'stage'='azure_provider_terminal' AND t->>'outcome'='succeeded')
  THEN RETURN false; END IF;
 END LOOP;
 RETURN true;
END;
$function$
$object$;
 ELSIF encode(sha256(convert_to(actual,'UTF8')),'hex') NOT IN ('38e7bcca28252de8a7ab6343d3f9fb3fdabf435cb58523ccedc8a851e230a4b5') THEN
  RAISE EXCEPTION 'Unqualified schema drift: byoc_azure_vm_upgrade_request_ready';
 END IF;
END
$object_guard$;

REVOKE ALL ON FUNCTION public."byoc_azure_vm_upgrade_request_ready"(jsonb, jsonb, jsonb) FROM PUBLIC;

DO $pod_414$
BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN GRANT EXECUTE ON FUNCTION public."byoc_azure_vm_upgrade_request_ready"(jsonb, jsonb, jsonb) TO service_role; END IF;
END
$pod_414$;

DO $object_guard$
DECLARE actual text;
BEGIN
 SELECT definition INTO actual FROM (SELECT pg_get_functiondef(p.oid) definition FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='byoc_azure_worker_admitted' AND pg_get_function_identity_arguments(p.oid)='owner_id text, expected_job text') observed;
 IF actual IS NULL THEN
  EXECUTE $object$CREATE OR REPLACE FUNCTION public.byoc_azure_worker_admitted(owner_id text, expected_job text)
 RETURNS boolean
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE agent public.personal_agent_registry%ROWTYPE;
 job public.byoc_setup_jobs%ROWTYPE; intent jsonb; matches integer;
BEGIN
 IF public.byoc_azure_setup_guards_ready() IS NOT TRUE THEN RETURN false; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(owner_id,171));
 PERFORM pg_advisory_xact_lock(hashtextextended(owner_id,198));
 SELECT * INTO agent FROM public.personal_agent_registry WHERE user_id=owner_id;
 IF NOT FOUND THEN RETURN false; END IF;
 SELECT * INTO job FROM public.byoc_setup_jobs WHERE user_id=owner_id;
 IF NOT FOUND OR job.job_id IS DISTINCT FROM expected_job OR job.status <> 'running'
    OR jsonb_typeof(job.stages) IS DISTINCT FROM 'array'
 THEN RETURN false; END IF;
 SELECT count(*), (jsonb_agg(s->'intent'))->0 INTO matches, intent
   FROM jsonb_array_elements(job.stages) s WHERE s->>'stage'='azure_setup_intent';
 RETURN matches=1 AND public.byoc_azure_intent_admitted(agent,job,intent) IS TRUE;
END;
$function$
$object$;
 ELSIF encode(sha256(convert_to(actual,'UTF8')),'hex') NOT IN ('df26c72a4d03f1d501796d67d6f6175fc224f482e9f3e12dfd1a72cb24634c0b') THEN
  RAISE EXCEPTION 'Unqualified schema drift: byoc_azure_worker_admitted';
 END IF;
END
$object_guard$;

REVOKE ALL ON FUNCTION public."byoc_azure_worker_admitted"(text, text) FROM PUBLIC;

DO $pod_414$
BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN GRANT EXECUTE ON FUNCTION public."byoc_azure_worker_admitted"(text, text) TO service_role; END IF;
END
$pod_414$;

DO $object_guard$
DECLARE actual text;
BEGIN
 SELECT definition INTO actual FROM (SELECT pg_get_functiondef(p.oid) definition FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='byoc_azure_worker_history_has_capacity' AND pg_get_function_identity_arguments(p.oid)='history jsonb') observed;
 IF actual IS NULL THEN
  EXECUTE $object$CREATE OR REPLACE FUNCTION public.byoc_azure_worker_history_has_capacity(history jsonb)
 RETURNS boolean
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public'
AS $function$
 WITH events AS (SELECT value e FROM jsonb_array_elements(history)), pending AS (
   SELECT request.e, EXISTS(SELECT 1 FROM events ack WHERE ack.e->>'stage'='azure_provider_ack'
     AND ack.e->>'requestId'=request.e->>'requestId') acknowledged
   FROM events request WHERE request.e->>'stage'='azure_provider_request'
    AND NOT EXISTS(SELECT 1 FROM events terminal WHERE terminal.e->>'stage'='azure_provider_terminal'
      AND terminal.e->>'requestId'=request.e->>'requestId')
 ), active AS (
   SELECT count(*) n FROM events worker WHERE worker.e->>'stage'='azure_worker_started'
    AND NOT EXISTS(SELECT 1 FROM events ended WHERE ended.e->>'stage'='azure_worker_exited'
      AND ended.e->>'executionId'=worker.e->>'executionId')
 ) SELECT jsonb_array_length(history)+(SELECT count(*) FROM pending)
    +(SELECT count(*) FROM pending WHERE NOT acknowledged)+(SELECT n FROM active)<=2048
   AND octet_length(history::text)+(SELECT count(*)*1024 FROM pending)
    +(SELECT count(*)*24576 FROM pending WHERE NOT acknowledged)
    +(SELECT n*512 FROM active)<=1048576;
$function$
$object$;
 ELSIF encode(sha256(convert_to(actual,'UTF8')),'hex') NOT IN ('ca7e01240ccbbba797fe37156434731a512f48e00de8a894c727b5ea179b62b9') THEN
  RAISE EXCEPTION 'Unqualified schema drift: byoc_azure_worker_history_has_capacity';
 END IF;
END
$object_guard$;

REVOKE ALL ON FUNCTION public."byoc_azure_worker_history_has_capacity"(jsonb) FROM PUBLIC;

DO $pod_414$
BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN GRANT EXECUTE ON FUNCTION public."byoc_azure_worker_history_has_capacity"(jsonb) TO service_role; END IF;
END
$pod_414$;

DO $object_guard$
DECLARE actual text;
BEGIN
 SELECT definition INTO actual FROM (SELECT pg_get_functiondef(p.oid) definition FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='byoc_azure_worker_session_held' AND pg_get_function_identity_arguments(p.oid)='owner_id text') observed;
 IF actual IS NULL THEN
  EXECUTE $object$CREATE OR REPLACE FUNCTION public.byoc_azure_worker_session_held(owner_id text)
 RETURNS boolean
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
 SELECT EXISTS (SELECT 1 FROM pg_locks WHERE pid=pg_backend_pid() AND locktype='advisory'
   AND granted AND mode='ExclusiveLock' AND objsubid=1
   AND classid=((hashtextextended(owner_id,206)>>32)&4294967295)::oid
   AND objid=(hashtextextended(owner_id,206)&4294967295)::oid);
$function$
$object$;
 ELSIF encode(sha256(convert_to(actual,'UTF8')),'hex') NOT IN ('ba9dad07ca2a0f30ee5212dc81caf55d70f622a22cffe3820e6b88252ec4d7a8') THEN
  RAISE EXCEPTION 'Unqualified schema drift: byoc_azure_worker_session_held';
 END IF;
END
$object_guard$;

REVOKE ALL ON FUNCTION public."byoc_azure_worker_session_held"(text) FROM PUBLIC;

DO $pod_414$
BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN GRANT EXECUTE ON FUNCTION public."byoc_azure_worker_session_held"(text) TO service_role; END IF;
END
$pod_414$;

DO $object_guard$
DECLARE actual text;
BEGIN
 SELECT definition INTO actual FROM (SELECT pg_get_functiondef(p.oid) definition FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='claim_personal_agent_provision' AND pg_get_function_identity_arguments(p.oid)='owner_id text, attempt_id text, observed jsonb, desired jsonb') observed;
 IF actual IS NULL THEN
  EXECUTE $object$CREATE OR REPLACE FUNCTION public.claim_personal_agent_provision(owner_id text, attempt_id text, observed jsonb, desired jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
  current_row public.personal_agent_registry%ROWTYPE;
  expected_row public.personal_agent_registry%ROWTYPE;
  target public.personal_agent_registry%ROWTYPE;
  reservation jsonb;
  row_exists boolean;
BEGIN
  IF owner_id IS NULL OR btrim(owner_id) = '' OR attempt_id IS NULL
     OR attempt_id !~ '^[a-f0-9]{32}$' OR jsonb_typeof(desired) IS DISTINCT FROM 'object'
     OR desired->>'user_id' IS DISTINCT FROM owner_id
     OR coalesce(desired->>'hushh_id','') = ''
     OR coalesce(desired->>'phone_e164_hash','') = ''
     OR desired - ARRAY['user_id','hushh_id','phone_e164_hash','billing_space_id',
          'deployment_target','model_credential_mode','user_cloud_project',
          'user_cloud_region','user_cloud_bootstrap_sa','pod_pubkey','pod_key_id',
          'pod_key_wrapping_alg'] <> '{}'::jsonb THEN
    RAISE EXCEPTION 'invalid personal agent provision admission' USING ERRCODE='42501';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(owner_id,171));
  PERFORM pg_advisory_xact_lock(hashtextextended(owner_id,198));
  IF EXISTS (SELECT 1 FROM public.account_deletion_tombstones
      WHERE user_id_hash='sha256:' || encode(digest(owner_id,'sha256'),'hex')) THEN
    RAISE EXCEPTION 'personal agent owner deleted' USING ERRCODE='42501';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgrelid='public.personal_agent_registry'::regclass
      AND tgname='zy_personal_agent_provision_registry' AND tgenabled IN ('O','A')
      AND tgtype=27 AND tgnargs=0 AND tgqual IS NULL
      AND tgfoid='public.guard_personal_agent_provision_registry()'::regprocedure
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgrelid='public.personal_agent_registry'::regclass
      AND tgname='zz_personal_agent_erasure_registry' AND tgenabled IN ('O','A')
      AND tgtype=27 AND tgnargs=0 AND tgqual IS NULL
      AND tgfoid='public.guard_personal_agent_erasure_registry()'::regprocedure
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgrelid='public.personal_agent_registry'::regclass
      AND tgname='trg_reject_deleted_account_insert' AND tgenabled IN ('O','A')
      AND tgtype=7 AND tgnargs=1 AND tgqual IS NULL
      AND tgargs=decode('757365725f696400','hex') -- user_id, NUL-terminated trigger argument
      AND tgfoid='public.reject_deleted_account_identity_write()'::regprocedure
  ) THEN
    RAISE EXCEPTION 'personal agent provision guards unavailable' USING ERRCODE='42501';
  END IF;
  SELECT * INTO current_row FROM public.personal_agent_registry WHERE user_id=owner_id FOR UPDATE;
  row_exists := FOUND;
  IF row_exists THEN
    -- Cloud publication locks the setup job before the registry. If it owns
    -- that row, refuse immediately instead of waiting in the reverse order.
    PERFORM 1 FROM public.byoc_setup_jobs WHERE user_id=owner_id FOR UPDATE NOWAIT;
    IF jsonb_typeof(observed) IS DISTINCT FROM 'object'
       OR observed->>'user_id' IS DISTINCT FROM owner_id
       OR NOT (observed ?& ARRAY['user_id','hushh_id','status','backend_metadata',
           'external_agent_id','a2a_route','pod_pubkey','deployment_target',
           'user_cloud_project','user_cloud_region','user_cloud_bootstrap_sa',
           'user_cloud_authorized_at']) THEN
      RAISE EXCEPTION 'personal agent provision observation changed' USING ERRCODE='42501';
    END IF;
    expected_row := jsonb_populate_record(NULL::public.personal_agent_registry, observed);
    IF EXISTS (SELECT 1 FROM jsonb_object_keys(observed) AS k(key)
               WHERE to_jsonb(current_row)->k.key IS DISTINCT FROM to_jsonb(expected_row)->k.key) THEN
      RAISE EXCEPTION 'personal agent provision observation changed' USING ERRCODE='42501';
    END IF;
    IF current_row.status NOT IN ('unprovisioned','pending','reaped','provisioning_failed')
       OR current_row.hushh_id IS DISTINCT FROM desired->>'hushh_id'
       OR current_row.external_agent_id IS NOT NULL
       -- A detached placement keeps the person's stable route; only that exact
       -- route, recorded by the newest detach for this identity, is admitted.
       OR (current_row.a2a_route IS NOT NULL AND (
         jsonb_typeof(current_row.backend_metadata->'detachedPlacements') IS DISTINCT FROM 'array'
         OR current_row.backend_metadata->'detachedPlacements'->-1->>'a2a_route'
              IS DISTINCT FROM current_row.a2a_route
         OR current_row.backend_metadata->'detachedPlacements'->-1->>'hushh_id'
              IS DISTINCT FROM current_row.hushh_id))
       OR current_row.pod_pubkey IS NOT NULL
       OR coalesce(current_row.backend_metadata,'{}'::jsonb)
            - ARRAY['observed','filesSetup','detachedPlacements'] <> '{}'::jsonb
       OR (current_row.backend_metadata ? 'detachedPlacements' AND (
         jsonb_typeof(current_row.backend_metadata->'detachedPlacements') IS DISTINCT FROM 'array'
         OR jsonb_array_length(current_row.backend_metadata->'detachedPlacements') = 0))
       OR (current_row.backend_metadata ? 'filesSetup' AND (
         jsonb_typeof(current_row.backend_metadata->'filesSetup') IS DISTINCT FROM 'object'
         OR (current_row.backend_metadata->'filesSetup')
              - ARRAY['version','enabled','project','bootstrapAccount','setupJobId'] <> '{}'::jsonb
         OR (
         current_row.deployment_target = 'user_gcp'
         AND current_row.user_cloud_project IS NOT NULL
         AND current_row.user_cloud_bootstrap_sa IS NOT NULL
         AND current_row.user_cloud_authorized_at IS NOT NULL
         AND current_row.backend_metadata->'filesSetup'->'version' = '1'::jsonb
         AND current_row.backend_metadata->'filesSetup'->'enabled' = 'true'::jsonb
         AND current_row.backend_metadata->'filesSetup'->>'project' = current_row.user_cloud_project
         AND current_row.backend_metadata->'filesSetup'->>'bootstrapAccount' = current_row.user_cloud_bootstrap_sa
         AND EXISTS (
           SELECT 1 FROM public.byoc_setup_jobs AS j
           WHERE j.user_id = owner_id
             AND j.job_id = current_row.backend_metadata->'filesSetup'->>'setupJobId'
             AND j.project_id = current_row.user_cloud_project
             AND j.status = 'recorded'
             AND j.stages @> '[{"stage":"files_selection","enabled":true,"version":1}]'::jsonb
         )
         ) IS NOT TRUE
       ))
       OR (current_row.deployment_target = 'user_gcp' AND EXISTS (
         SELECT 1 FROM public.byoc_setup_jobs AS j
         WHERE j.user_id = owner_id
           AND (j.status = 'running' OR
                (j.project_id = current_row.user_cloud_project AND j.status <> 'recorded'))
       )) THEN
      RAISE EXCEPTION 'personal agent provision requires reconciliation' USING ERRCODE='42501';
    END IF;
  ELSIF observed IS NOT NULL AND observed <> 'null'::jsonb THEN
    RAISE EXCEPTION 'personal agent provision observation changed' USING ERRCODE='42501';
  END IF;
  target := jsonb_populate_record(current_row, desired);
  IF row_exists AND current_row.backend_metadata ? 'filesSetup'
     AND (target.deployment_target IS DISTINCT FROM current_row.deployment_target
          OR target.model_credential_mode IS DISTINCT FROM current_row.model_credential_mode
          OR target.user_cloud_project IS DISTINCT FROM current_row.user_cloud_project
          OR target.user_cloud_region IS DISTINCT FROM current_row.user_cloud_region
          OR target.user_cloud_bootstrap_sa IS DISTINCT FROM current_row.user_cloud_bootstrap_sa) THEN
    RAISE EXCEPTION 'personal agent Files placement changed' USING ERRCODE='42501';
  END IF;
  reservation := jsonb_build_object('version',1,'ownerId',owner_id,'attemptId',attempt_id,
      'phase','reserved','intent',desired,'createdAt',clock_timestamp());
  INSERT INTO public.personal_agent_registry AS r (
    user_id,hushh_id,phone_e164_hash,billing_space_id,deployment_target,model_credential_mode,
    user_cloud_project,user_cloud_region,user_cloud_bootstrap_sa,pod_pubkey,pod_key_id,
    pod_key_wrapping_alg,status,backend_metadata,
    user_cloud_tenant_id,user_cloud_subscription_id,user_cloud_resource_group
  ) VALUES (
    owner_id,target.hushh_id,target.phone_e164_hash,target.billing_space_id,
    target.deployment_target,target.model_credential_mode,target.user_cloud_project,
    target.user_cloud_region,target.user_cloud_bootstrap_sa,target.pod_pubkey,
    target.pod_key_id,target.pod_key_wrapping_alg,'provisioning',
    coalesce(current_row.backend_metadata,'{}'::jsonb) || jsonb_build_object('provisionAttempt',reservation),
    -- CHECK constraints judge the proposed insert row before ON CONFLICT, so an
    -- Azure home's coordinates (948) must ride along; the update leaves them as-is.
    current_row.user_cloud_tenant_id,current_row.user_cloud_subscription_id,
    current_row.user_cloud_resource_group
  ) ON CONFLICT (user_id) DO UPDATE SET
    hushh_id=EXCLUDED.hushh_id,phone_e164_hash=EXCLUDED.phone_e164_hash,
    billing_space_id=EXCLUDED.billing_space_id,deployment_target=EXCLUDED.deployment_target,
    model_credential_mode=EXCLUDED.model_credential_mode,user_cloud_project=EXCLUDED.user_cloud_project,
    user_cloud_region=EXCLUDED.user_cloud_region,user_cloud_bootstrap_sa=EXCLUDED.user_cloud_bootstrap_sa,
    pod_pubkey=EXCLUDED.pod_pubkey,pod_key_id=EXCLUDED.pod_key_id,
    pod_key_wrapping_alg=EXCLUDED.pod_key_wrapping_alg,status='provisioning',
    backend_metadata=EXCLUDED.backend_metadata,updated_at=clock_timestamp()
    WHERE row_exists AND to_jsonb(r)=to_jsonb(current_row);
  IF NOT FOUND THEN
    RAISE EXCEPTION 'personal agent provision observation changed' USING ERRCODE='42501';
  END IF;
  RETURN reservation;
END;
$function$
$object$;
 ELSIF encode(sha256(convert_to(actual,'UTF8')),'hex') NOT IN ('af07d533ec5a7a821f292cf5bdb07ea96f155a06cab5b7cfc63cc40a9b929e3b') THEN
  RAISE EXCEPTION 'Unqualified schema drift: claim_personal_agent_provision';
 END IF;
END
$object_guard$;

REVOKE ALL ON FUNCTION public."claim_personal_agent_provision"(text, text, jsonb, jsonb) FROM PUBLIC;

DO $pod_414$
BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN GRANT EXECUTE ON FUNCTION public."claim_personal_agent_provision"(text, text, jsonb, jsonb) TO service_role; END IF;
END
$pod_414$;

DO $object_guard$
DECLARE actual text;
BEGIN
 SELECT definition INTO actual FROM (SELECT pg_get_functiondef(p.oid) definition FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='effective_erasure_azure_files_inventory' AND pg_get_function_identity_arguments(p.oid)='r jsonb') observed;
 IF actual IS NULL THEN
  EXECUTE $object$CREATE OR REPLACE FUNCTION public.effective_erasure_azure_files_inventory(r jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 IMMUTABLE
 SET search_path TO 'public'
AS $function$
DECLARE inventory jsonb:=r->'registrySnapshot'->'backend_metadata'->'azureFilesInventory';
 observation jsonb:=r->'lateFilesUpgradeObservation'; result jsonb;
BEGIN
 IF observation IS NULL THEN RETURN inventory; END IF;
 IF public.valid_erasure_azure_files_upgrade_observation(r,observation) IS DISTINCT FROM true THEN RETURN NULL; END IF;
 result:=observation->'completed'->-1;
 IF result->'ok'='true'::jsonb THEN
  inventory:=jsonb_set(inventory,'{observations}',coalesce(inventory->'observations','[]'::jsonb)||jsonb_build_array(result->'observation'),true);
 END IF;
 RETURN inventory;
END $function$
$object$;
 ELSIF encode(sha256(convert_to(actual,'UTF8')),'hex') NOT IN ('90e318c997e298a8a85b2c5361b9fcb1777e7416e8d62aea9e669621f3e97c7a') THEN
  RAISE EXCEPTION 'Unqualified schema drift: effective_erasure_azure_files_inventory';
 END IF;
END
$object_guard$;

REVOKE ALL ON FUNCTION public."effective_erasure_azure_files_inventory"(jsonb) FROM PUBLIC;

DO $pod_414$
BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN GRANT EXECUTE ON FUNCTION public."effective_erasure_azure_files_inventory"(jsonb) TO service_role; END IF;
END
$pod_414$;

DO $object_guard$
DECLARE actual text;
BEGIN
 SELECT definition INTO actual FROM (SELECT pg_get_functiondef(p.oid) definition FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='effective_erasure_substrate_inventory' AND pg_get_function_identity_arguments(p.oid)='r jsonb') observed;
 IF actual IS NULL THEN
  EXECUTE $object$CREATE OR REPLACE FUNCTION public.effective_erasure_substrate_inventory(r jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 IMMUTABLE
 SET search_path TO 'public'
AS $function$
DECLARE inventory jsonb:=r->'registrySnapshot'->'backend_metadata'->'substrateReceipt';
 observation jsonb:=r->'lateFilesUpgradeObservation'; result jsonb; item jsonb; values_array jsonb;
BEGIN
 -- 956: merge the frozen notification intent and the one qualified late receipt.
 IF r->'registrySnapshot'->'backend_metadata' ? 'notificationCheckpoint' THEN
  inventory:=public.notification_checkpoint_inventory(inventory,r->'registrySnapshot'->'backend_metadata'->'notificationCheckpoint');
 END IF;
 IF r ? 'lateNotificationObservation' THEN
  IF public.valid_erasure_notification_observation(r,r->'lateNotificationObservation') IS DISTINCT FROM true THEN RETURN NULL; END IF;
  inventory:=public.notification_checkpoint_inventory(inventory,r->'lateNotificationObservation');
 END IF;
 IF inventory IS NULL OR observation IS NULL THEN RETURN inventory; END IF;
 IF public.valid_erasure_files_upgrade_observation(r,observation) IS DISTINCT FROM true THEN RETURN NULL; END IF;
 result:=observation->'completed'->-1;
 IF result ? 'resourceObservation' THEN
  item:=result->'resourceObservation'; values_array:=coalesce(inventory->'resourceObservations','[]'::jsonb);
  IF NOT values_array @> jsonb_build_array(item) THEN values_array:=values_array||jsonb_build_array(item); END IF;
  inventory:=jsonb_set(inventory,'{resourceObservations}',values_array,true);
 END IF;
 IF result ? 'bindingObservations' THEN
  values_array:=coalesce(inventory->'bindingObservations','[]'::jsonb);
  FOR item IN SELECT value FROM jsonb_array_elements(result->'bindingObservations') LOOP
   IF NOT values_array @> jsonb_build_array(item) THEN values_array:=values_array||jsonb_build_array(item); END IF;
  END LOOP;
  inventory:=jsonb_set(inventory,'{bindingObservations}',values_array,true);
 END IF;
 RETURN inventory;
END;
$function$
$object$;
 ELSIF encode(sha256(convert_to(actual,'UTF8')),'hex') NOT IN ('34203e1fba8fa77a0617712ef5f4eb1d3e18dad62777f97a9b1ee3ba5b718995') THEN
  RAISE EXCEPTION 'Unqualified schema drift: effective_erasure_substrate_inventory';
 END IF;
END
$object_guard$;

REVOKE ALL ON FUNCTION public."effective_erasure_substrate_inventory"(jsonb) FROM PUBLIC;

DO $pod_414$
BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN GRANT EXECUTE ON FUNCTION public."effective_erasure_substrate_inventory"(jsonb) TO service_role; END IF;
END
$pod_414$;

DO $object_guard$
DECLARE actual text;
BEGIN
 SELECT definition INTO actual FROM (SELECT pg_get_functiondef(p.oid) definition FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='erasure_mail_resource_state' AND pg_get_function_identity_arguments(p.oid)='r jsonb, kind text, resource_id text') observed;
 IF actual IS NULL THEN
  EXECUTE $object$CREATE OR REPLACE FUNCTION public.erasure_mail_resource_state(r jsonb, kind text, resource_id text)
 RETURNS jsonb
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public'
AS $function$
 SELECT CASE WHEN r->'mailErasure'->kind->'resources' ? resource_id THEN r->'mailErasure'->kind->'resources'->resource_id
 WHEN r->'mailErasure'->kind->'admission'->'resourceObservation'->>'id'=resource_id THEN (r->'mailErasure'->kind)-'resources'
 ELSE '{}'::jsonb END;
$function$
$object$;
 ELSIF encode(sha256(convert_to(actual,'UTF8')),'hex') NOT IN ('e9aea50c18386551ac6f180743543f50b8e7c356736adf9e3845c44329e2df62') THEN
  RAISE EXCEPTION 'Unqualified schema drift: erasure_mail_resource_state';
 END IF;
END
$object_guard$;

REVOKE ALL ON FUNCTION public."erasure_mail_resource_state"(jsonb, text, text) FROM PUBLIC;

DO $pod_414$
BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN GRANT EXECUTE ON FUNCTION public."erasure_mail_resource_state"(jsonb, text, text) TO service_role; END IF;
END
$pod_414$;

DO $object_guard$
DECLARE actual text;
BEGIN
 SELECT definition INTO actual FROM (SELECT pg_get_functiondef(p.oid) definition FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='erasure_mail_resources_deleted' AND pg_get_function_identity_arguments(p.oid)='r jsonb') observed;
 IF actual IS NULL THEN
  EXECUTE $object$CREATE OR REPLACE FUNCTION public.erasure_mail_resources_deleted(r jsonb)
 RETURNS boolean
 LANGUAGE plpgsql
 IMMUTABLE
 SET search_path TO 'public'
AS $function$
DECLARE item jsonb; kind text; states jsonb;
BEGIN
 IF jsonb_typeof(r->'substrateInventory'->'plannedResources') IS DISTINCT FROM 'array' THEN RETURN false; END IF;
 FOREACH kind IN ARRAY ARRAY['cloud_scheduler_job','pubsub_subscription','pubsub_topic'] LOOP
  IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(r->'substrateInventory'->'plannedResources') x WHERE x->>'type'=kind) THEN RETURN false; END IF;
  FOR item IN SELECT value FROM jsonb_array_elements(r->'substrateInventory'->'plannedResources') x WHERE x->>'type'=kind LOOP
   states:=public.erasure_mail_resource_state(r,kind,item->>'id');
   IF public.valid_erasure_mail_receipt(r,kind,'deletion',states->'deletion') IS DISTINCT FROM true THEN RETURN false; END IF;
  END LOOP;
 END LOOP;
 RETURN true;
END;
$function$
$object$;
 ELSIF encode(sha256(convert_to(actual,'UTF8')),'hex') NOT IN ('ef37682d25ecd70a27dc83c7434ea6c7dd56bcf60aabcbf7b33cf31fc36479c8') THEN
  RAISE EXCEPTION 'Unqualified schema drift: erasure_mail_resources_deleted';
 END IF;
END
$object_guard$;

REVOKE ALL ON FUNCTION public."erasure_mail_resources_deleted"(jsonb) FROM PUBLIC;

DO $pod_414$
BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN GRANT EXECUTE ON FUNCTION public."erasure_mail_resources_deleted"(jsonb) TO service_role; END IF;
END
$pod_414$;

DO $object_guard$
DECLARE actual text;
BEGIN
 SELECT definition INTO actual FROM (SELECT pg_get_functiondef(p.oid) definition FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='erasure_never_hosted_admitted' AND pg_get_function_identity_arguments(p.oid)='owner_id text, r jsonb') observed;
 IF actual IS NULL THEN
  EXECUTE $object$CREATE OR REPLACE FUNCTION public.erasure_never_hosted_admitted(owner_id text, r jsonb)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public'
AS $function$
DECLARE receipt jsonb;
BEGIN
 IF jsonb_typeof(r) IS DISTINCT FROM 'object' OR NOT (r ? 'neverHosted') THEN RETURN false; END IF;
 receipt:=public.expected_erasure_never_hosted(owner_id,r);
 RETURN coalesce(receipt IS NOT NULL
  AND r - ARRAY['version','ownerId','attemptId','hushhId','phase','registrySnapshot',
                'neverHosted','grantRelease','bootstrapGrantRelease','bootstrapGrantErasure']='{}'::jsonb
  AND r->'neverHosted'=receipt
  AND r->'grantRelease'=jsonb_build_object('ownerId',owner_id,'attemptId',r->>'attemptId',
       'project',receipt->>'project','status','reserved'), false);
END;
$function$
$object$;
 ELSIF encode(sha256(convert_to(actual,'UTF8')),'hex') NOT IN ('66c8755777226ddb152ea463a8f3efa4d5def367a25eb85130ac433861f69ed1') THEN
  RAISE EXCEPTION 'Unqualified schema drift: erasure_never_hosted_admitted';
 END IF;
END
$object_guard$;

REVOKE ALL ON FUNCTION public."erasure_never_hosted_admitted"(text, jsonb) FROM PUBLIC;

DO $pod_414$
BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN GRANT EXECUTE ON FUNCTION public."erasure_never_hosted_admitted"(text, jsonb) TO service_role; END IF;
END
$pod_414$;

DO $object_guard$
DECLARE actual text;
BEGIN
 SELECT definition INTO actual FROM (SELECT pg_get_functiondef(p.oid) definition FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='erasure_planned_resources_covered' AND pg_get_function_identity_arguments(p.oid)='r jsonb') observed;
 IF actual IS NULL THEN
  EXECUTE $object$CREATE OR REPLACE FUNCTION public.erasure_planned_resources_covered(r jsonb)
 RETURNS boolean
 LANGUAGE plpgsql
 IMMUTABLE
 SET search_path TO 'public'
AS $function$
DECLARE planned jsonb:=r->'substrateInventory'->'plannedResources'; item jsonb; receipt jsonb;
 kind text; captured_id text; wanted_status text;
BEGIN
 -- Coverage supplements existing immutable receipt validation; it never grants deletion authority.
 IF jsonb_typeof(planned) IS DISTINCT FROM 'array' OR jsonb_array_length(planned) NOT BETWEEN 1 AND 1024
 OR (SELECT count(*)<>count(DISTINCT x) FROM jsonb_array_elements(planned) x) THEN RETURN false; END IF;
 FOR item IN SELECT value FROM jsonb_array_elements(planned) LOOP
  IF jsonb_typeof(item) IS DISTINCT FROM 'object' OR item-ARRAY['type','id']<>'{}'::jsonb
   OR jsonb_typeof(item->'id') IS DISTINCT FROM 'string' OR length(item->>'id')=0 THEN RETURN false; END IF;
  kind:=item->>'type'; receipt:=NULL; captured_id:=NULL; wanted_status:=NULL;
  CASE kind
   WHEN 'cloud_run_service' THEN
    receipt:=r->'computeDeletion'; captured_id:=split_part(receipt->>'serviceName','/',6); wanted_status:='compute_deleted';
   WHEN 'gcs_bucket' THEN
    receipt:=r->'bucketDeletion'; captured_id:=receipt->'bucketIdentity'->>'name'; wanted_status:='deleted';
   WHEN 'service_account' THEN
    IF item->>'id'=r->'writerDisabled'->'runtimeIdentity'->>'email' THEN
     receipt:=r->'accountErasure'->'deletion';
    ELSE
     receipt:=r->'filesErasure'->'worker'->'deletion';
     IF public.valid_erasure_files_receipt(r,'worker','deletion',receipt) IS DISTINCT FROM true THEN RETURN false; END IF;
    END IF;
    captured_id:=receipt->'resourceObservation'->>'id'; wanted_status:='absent';
   WHEN 'cloud_tasks_queue' THEN
    receipt:=r->'filesErasure'->'queue'->'deletion';
    IF public.valid_erasure_files_receipt(r,'queue','deletion',receipt) IS DISTINCT FROM true THEN RETURN false; END IF;
    captured_id:=receipt->'resourceObservation'->>'id'; wanted_status:='absent';
   WHEN 'kms_key' THEN
    receipt:=r->'kmsErasure'->'completion'; captured_id:=receipt->'resourceObservation'->>'id'; wanted_status:='destroyed';
   WHEN 'secret' THEN
    receipt:=r->'secretErasure'->'deletion'; captured_id:=receipt->'resourceObservation'->>'id'; wanted_status:='absent';
   WHEN 'artifact_repository' THEN
    receipt:=r->'repositoryRetention'; captured_id:=split_part(receipt->'repositoryIdentity'->>'name','/',6);
    IF receipt->>'disposition' IS DISTINCT FROM 'retained_shared' THEN RETURN false; END IF;
   WHEN 'cloud_scheduler_job','pubsub_subscription','pubsub_topic' THEN
    -- 956: exact ID; a sibling receipt never covers this resource.
    receipt:=public.erasure_mail_resource_state(r,kind,item->>'id')->'deletion';
    captured_id:=receipt->'resourceObservation'->>'id'; wanted_status:='absent';
   ELSE RETURN false;
  END CASE;
  IF captured_id IS DISTINCT FROM item->>'id' OR jsonb_typeof(receipt) IS DISTINCT FROM 'object'
   OR (wanted_status IS NOT NULL AND receipt->>'status' IS DISTINCT FROM wanted_status) THEN RETURN false; END IF;
  -- Compute receipts are bound through the existing compute admission contract.
  IF kind<>'cloud_run_service' AND (receipt->>'ownerId' IS DISTINCT FROM r->>'ownerId'
   OR receipt->>'attemptId' IS DISTINCT FROM r->>'attemptId') THEN RETURN false; END IF;
 END LOOP;
 RETURN true;
END;
$function$
$object$;
 ELSIF encode(sha256(convert_to(actual,'UTF8')),'hex') NOT IN ('7e444618753d23c0b132709a00a80da9159fe0a0cfbd57daabf63460d38c6d77') THEN
  RAISE EXCEPTION 'Unqualified schema drift: erasure_planned_resources_covered';
 END IF;
END
$object_guard$;

REVOKE ALL ON FUNCTION public."erasure_planned_resources_covered"(jsonb) FROM PUBLIC;

DO $pod_414$
BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN GRANT EXECUTE ON FUNCTION public."erasure_planned_resources_covered"(jsonb) TO service_role; END IF;
END
$pod_414$;

DO $object_guard$
DECLARE actual text;
BEGIN
 SELECT definition INTO actual FROM (SELECT pg_get_functiondef(p.oid) definition FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='erasure_provider_revocation_complete' AND pg_get_function_identity_arguments(p.oid)='reservation jsonb') observed;
 IF actual IS NULL THEN
  EXECUTE $object$CREATE OR REPLACE FUNCTION public.erasure_provider_revocation_complete(reservation jsonb)
 RETURNS boolean
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public'
AS $function$
 SELECT coalesce(public.valid_erasure_owner_access_checkpoint(
   reservation,reservation->'agentCryptoErase') IS TRUE
  AND reservation#>'{agentCryptoErase,agentErased,providerCoverage}'=
      '"connector_history_v1"'::jsonb
  AND reservation#>'{agentCryptoErase,agentErased,providerUnconfirmed}'='0'::jsonb
  AND reservation#>'{agentCryptoErase,agentErased,providerUnavailable}'='0'::jsonb,false);
$function$
$object$;
 ELSIF encode(sha256(convert_to(actual,'UTF8')),'hex') NOT IN ('41ffa0dfe45ef3747f93ee4fffc7c28bf836bdec8655af2fe4482b9b9daf4b0d') THEN
  RAISE EXCEPTION 'Unqualified schema drift: erasure_provider_revocation_complete';
 END IF;
END
$object_guard$;

REVOKE ALL ON FUNCTION public."erasure_provider_revocation_complete"(jsonb) FROM PUBLIC;

DO $pod_414$
BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN GRANT EXECUTE ON FUNCTION public."erasure_provider_revocation_complete"(jsonb) TO service_role; END IF;
END
$pod_414$;

DO $object_guard$
DECLARE actual text;
BEGIN
 SELECT definition INTO actual FROM (SELECT pg_get_functiondef(p.oid) definition FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='erasure_runtime_grants_complete' AND pg_get_function_identity_arguments(p.oid)='r jsonb') observed;
 IF actual IS NULL THEN
  EXECUTE $object$CREATE OR REPLACE FUNCTION public.erasure_runtime_grants_complete(r jsonb)
 RETURNS boolean
 LANGUAGE plpgsql
 IMMUTABLE
 SET search_path TO 'public'
AS $function$
DECLARE inventory jsonb:=r->'substrateInventory'; required boolean; observed jsonb; quota_receipt jsonb;
BEGIN
 IF public.valid_erasure_runtime_grant_receipt(r,'deletion',r->'runtimeGrantErasure'->'deletion') IS DISTINCT FROM true THEN RETURN false; END IF;
 required:=EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(inventory->'plannedBindings','[]'::jsonb)) b WHERE b->>'role'='roles/serviceusage.serviceUsageConsumer')
  OR EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(inventory->'bindingObservations','[]'::jsonb)) b WHERE b->>'role'='roles/serviceusage.serviceUsageConsumer' OR b->>'step'='iam_pod_sa_quota')
  OR r->'runtimeGrantErasure' ? 'quota';
 IF NOT required THEN RETURN true; END IF;
 IF (SELECT count(*) FROM jsonb_array_elements(coalesce(inventory->'bindingObservations','[]'::jsonb)) b WHERE b->>'role'='roles/serviceusage.serviceUsageConsumer' OR b->>'step'='iam_pod_sa_quota')<>1 THEN RETURN false; END IF;
 SELECT b INTO observed FROM jsonb_array_elements(inventory->'bindingObservations') b WHERE b->>'role'='roles/serviceusage.serviceUsageConsumer' OR b->>'step'='iam_pod_sa_quota';
 quota_receipt:=r->'runtimeGrantErasure'->'quota'->'deletion';
 RETURN quota_receipt->'bindingObservation' IS NOT DISTINCT FROM observed
  AND public.valid_erasure_runtime_grant_receipt(r,'deletion',quota_receipt) IS TRUE;
END;
$function$
$object$;
 ELSIF encode(sha256(convert_to(actual,'UTF8')),'hex') NOT IN ('f71c91b1badbecb1cc10ae4ff698af1d09d2d29b8f1b1061d5974bf98ee91a4c') THEN
  RAISE EXCEPTION 'Unqualified schema drift: erasure_runtime_grants_complete';
 END IF;
END
$object_guard$;

REVOKE ALL ON FUNCTION public."erasure_runtime_grants_complete"(jsonb) FROM PUBLIC;

DO $pod_414$
BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN GRANT EXECUTE ON FUNCTION public."erasure_runtime_grants_complete"(jsonb) TO service_role; END IF;
END
$pod_414$;

DO $object_guard$
DECLARE actual text;
BEGIN
 SELECT definition INTO actual FROM (SELECT pg_get_functiondef(p.oid) definition FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='expected_erasure_bootstrap_release' AND pg_get_function_identity_arguments(p.oid)='owner_id text, r jsonb, recovery_member text') observed;
 IF actual IS NULL THEN
  EXECUTE $object$CREATE OR REPLACE FUNCTION public.expected_erasure_bootstrap_release(owner_id text, r jsonb, recovery_member text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public'
AS $function$
DECLARE history jsonb; job record; identity jsonb; binding jsonb; groups jsonb:='{}'::jsonb;
 g jsonb; k text; target_project text; recovery_key text; n integer:=0;
BEGIN
 -- 954: a never-hosted reservation has no planned resources and no repository; its
 -- re-derived receipt stands in for both. Every other reservation is unchanged.
 IF public.erasure_never_hosted_admitted(owner_id,r) IS DISTINCT FROM true THEN
 IF public.erasure_planned_resources_covered(r) IS DISTINCT FROM true THEN RETURN NULL; END IF;
 IF public.valid_erasure_repository_retention(r,r->'repositoryRetention') IS DISTINCT FROM true THEN RETURN NULL; END IF;
 END IF;
 target_project:=r->'registrySnapshot'->>'user_cloud_project';
 SELECT authorization_attempts INTO history FROM public.byoc_setup_jobs WHERE user_id=owner_id;
 IF jsonb_typeof(history) IS DISTINCT FROM 'object' THEN RETURN NULL; END IF;
 FOR job IN SELECT key,value FROM jsonb_each(history) ORDER BY key LOOP
  IF job.value->'intent'->>'project' IS DISTINCT FROM target_project THEN CONTINUE; END IF;
  n:=n+1;
  IF n>1024 OR job.value->'intent'->>'ownerId' IS DISTINCT FROM owner_id
   OR job.value->'intent'->>'jobId' IS DISTINCT FROM job.key OR NOT (job.value ? 'receipt') THEN RETURN NULL; END IF;
  identity:=job.value->'receipt'->'bootstrapIdentity'; binding:=job.value->'receipt'->'bindingObservation';
  IF identity->>'projectId' IS DISTINCT FROM target_project OR binding->>'role' IS DISTINCT FROM 'roles/iam.serviceAccountTokenCreator'
   OR binding->>'member' IS DISTINCT FROM 'serviceAccount:'||(job.value->'intent'->>'callerEmail')
   OR (binding->>'disposition' IN ('added','already_present')) IS DISTINCT FROM true THEN RETURN NULL; END IF;
  k:=(identity->>'uniqueId')||'|'||(binding->>'member');
  IF k IS NULL THEN RETURN NULL; END IF;
  g:=groups->k;
  IF g IS NULL THEN g:=jsonb_build_object('jobIds','[]'::jsonb,'bootstrapIdentity',identity,'bindingObservation',NULL); END IF;
  IF g->'bootstrapIdentity' IS DISTINCT FROM identity THEN RETURN NULL; END IF;
  g:=jsonb_set(g,'{jobIds}',(g->'jobIds')||jsonb_build_array(job.key));
  IF binding->>'disposition'='added' AND g->'bindingObservation'='null'::jsonb THEN g:=jsonb_set(g,'{bindingObservation}',binding); END IF;
  groups:=jsonb_set(groups,ARRAY[k],g,true);
  IF binding->>'member'=recovery_member AND identity->>'email'=regexp_replace(r->'registrySnapshot'->>'user_cloud_bootstrap_sa','^serviceAccount:','') THEN
   IF recovery_key IS NOT NULL AND recovery_key<>k THEN RETURN NULL; END IF;
   recovery_key:=k;
  END IF;
 END LOOP;
 IF n=0 OR recovery_key IS NULL THEN RETURN NULL; END IF;
 FOR g IN SELECT value FROM jsonb_each(groups) LOOP
  IF g->'bindingObservation'='null'::jsonb THEN RETURN NULL; END IF;
 END LOOP;
 RETURN jsonb_build_object('ownerId',owner_id,'attemptId',r->>'attemptId','project',target_project,
  'groups',groups,'recoveryMember',recovery_member,'recoveryGrantKey',recovery_key,'status','reserved');
END;
$function$
$object$;
 ELSIF encode(sha256(convert_to(actual,'UTF8')),'hex') NOT IN ('9c7df549d997f7e00af73bdc28816ca337452ff340ea232b0acf27a486b04897') THEN
  RAISE EXCEPTION 'Unqualified schema drift: expected_erasure_bootstrap_release';
 END IF;
END
$object_guard$;

REVOKE ALL ON FUNCTION public."expected_erasure_bootstrap_release"(text, jsonb, text) FROM PUBLIC;

DO $pod_414$
BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN GRANT EXECUTE ON FUNCTION public."expected_erasure_bootstrap_release"(text, jsonb, text) TO service_role; END IF;
END
$pod_414$;

DO $object_guard$
DECLARE actual text;
BEGIN
 SELECT definition INTO actual FROM (SELECT pg_get_functiondef(p.oid) definition FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='expected_erasure_never_hosted' AND pg_get_function_identity_arguments(p.oid)='owner_id text, r jsonb') observed;
 IF actual IS NULL THEN
  EXECUTE $object$CREATE OR REPLACE FUNCTION public.expected_erasure_never_hosted(owner_id text, r jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public'
AS $function$
DECLARE s jsonb; live public.personal_agent_registry%ROWTYPE; setup public.byoc_setup_jobs%ROWTYPE;
 project text; sa text;
BEGIN
 -- Types first, each on its own: a jsonb operator on the wrong type raises.
 IF owner_id IS NULL OR btrim(owner_id)='' OR jsonb_typeof(r) IS DISTINCT FROM 'object'
 OR jsonb_typeof(r->'registrySnapshot') IS DISTINCT FROM 'object' THEN RETURN NULL; END IF;
 s:=r->'registrySnapshot';
 project:=s->>'user_cloud_project';
 sa:=regexp_replace(coalesce(s->>'user_cloud_bootstrap_sa',''),'^serviceAccount:','');
 IF r->>'ownerId' IS DISTINCT FROM owner_id OR r->>'version' IS DISTINCT FROM '1'
 OR r->>'phase' IS DISTINCT FROM 'reserved'
 OR coalesce(r->>'attemptId','')='' OR coalesce(r->>'hushhId','')=''
 OR s->>'user_id' IS DISTINCT FROM owner_id OR s->>'hushh_id' IS DISTINCT FROM r->>'hushhId'
 -- Pre-host only, and only the person's own Google Cloud project: never the managed tier.
 OR (s->>'status' IN ('pending','unprovisioned')) IS NOT TRUE
 OR s->>'deployment_target' IS DISTINCT FROM 'user_gcp'
 OR nullif(s->>'backend','') IS NOT NULL OR nullif(s->>'external_agent_id','') IS NOT NULL
 -- No provisionAttempt, serviceUid, service or anything else: 917 claims before substrate.
 OR (jsonb_typeof(s->'backend_metadata')='null' OR s->'backend_metadata'='{}'::jsonb) IS NOT TRUE
 OR (project ~ '^[a-z][a-z0-9-]{4,61}[a-z0-9]$') IS NOT TRUE
 OR (sa ~ ('^[a-z][a-z0-9-]{4,28}[a-z0-9]@'||project||'\.iam\.gserviceaccount\.com$')) IS NOT TRUE
 THEN RETURN NULL; END IF;
 -- The live row is this reservation, frozen, and still carries nothing hosted.
 SELECT * INTO live FROM public.personal_agent_registry WHERE user_id=owner_id;
 IF NOT FOUND OR live.status IS DISTINCT FROM 'suspended'
 OR live.hushh_id IS DISTINCT FROM r->>'hushhId' OR live.user_cloud_project IS DISTINCT FROM project
 OR nullif(live.backend,'') IS NOT NULL OR nullif(live.external_agent_id,'') IS NOT NULL
 OR jsonb_typeof(live.backend_metadata) IS DISTINCT FROM 'object'
 OR live.backend_metadata-'erasure'<>'{}'::jsonb
 OR live.backend_metadata->'erasure'->'registrySnapshot' IS DISTINCT FROM s
 OR live.backend_metadata->'erasure'->>'attemptId' IS DISTINCT FROM r->>'attemptId' THEN RETURN NULL; END IF;
 -- Only a registry row (and a pre-host failure) was ever logged: no host_* stage,
 -- no substrate_step, nothing else. An allow-list, so a new event kind refuses.
 IF EXISTS (SELECT 1 FROM public.pod_lifecycle_events e WHERE e.user_id=owner_id AND (
   e.substrate_step IS NOT NULL
   OR NOT ((coalesce(e.event,'')='stage' AND coalesce(e.stage,'') IN ('registry_row','failed'))
           OR (coalesce(e.event,'')='terminal' AND coalesce(e.stage,'')='failed'))))
 OR EXISTS (SELECT 1 FROM public.pod_migration_jobs WHERE user_id=owner_id) THEN RETURN NULL; END IF;
 SELECT * INTO setup FROM public.byoc_setup_jobs WHERE user_id=owner_id;
 IF NOT FOUND OR setup.status IS DISTINCT FROM 'recorded' OR setup.project_id IS DISTINCT FROM project THEN
  RETURN NULL; END IF;
 RETURN jsonb_build_object('version',1,'ownerId',owner_id,'attemptId',r->>'attemptId',
  'hushhId',r->>'hushhId','status','never_hosted','project',project,
  'remainsWithPerson',jsonb_build_array('projects/'||project,'projects/'||project||'/serviceAccounts/'||sa),
  'deletedByHussh','[]'::jsonb,'husshReleases','bootstrapGrantRelease');
END;
$function$
$object$;
 ELSIF encode(sha256(convert_to(actual,'UTF8')),'hex') NOT IN ('dc6f612946a19e219289e66224bbec29331ef6d6aab55d0e6d2b01403878db31') THEN
  RAISE EXCEPTION 'Unqualified schema drift: expected_erasure_never_hosted';
 END IF;
END
$object_guard$;

REVOKE ALL ON FUNCTION public."expected_erasure_never_hosted"(text, jsonb) FROM PUBLIC;

DO $pod_414$
BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN GRANT EXECUTE ON FUNCTION public."expected_erasure_never_hosted"(text, jsonb) TO service_role; END IF;
END
$pod_414$;

DO $object_guard$
DECLARE actual text;
BEGIN
 SELECT definition INTO actual FROM (SELECT pg_get_functiondef(p.oid) definition FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='files_upgrade_admission_ready' AND pg_get_function_identity_arguments(p.oid)='') observed;
 IF actual IS NULL THEN
  EXECUTE $object$CREATE OR REPLACE FUNCTION public.files_upgrade_admission_ready()
 RETURNS boolean
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
 SELECT to_regprocedure('public.retain_erasure_files_upgrade_observation(text,text,jsonb)') IS NOT NULL
 AND to_regprocedure('public.effective_erasure_substrate_inventory(jsonb)') IS NOT NULL
 AND EXISTS (SELECT 1 FROM pg_trigger
   WHERE tgrelid='public.personal_agent_registry'::regclass
   AND tgname='zz_personal_agent_erasure_registry' AND tgenabled IN ('O','A')
   AND tgtype=27 AND tgnargs=0 AND tgqual IS NULL
   AND tgfoid='public.guard_personal_agent_erasure_registry()'::regprocedure)
 AND position('valid_erasure_files_upgrade_observation' IN
   pg_get_functiondef('public.guard_personal_agent_erasure_registry()'::regprocedure))>0;
$function$
$object$;
 ELSIF encode(sha256(convert_to(actual,'UTF8')),'hex') NOT IN ('b7b60698517daa1cbd5d83084e5b965b6740988791d3ca6d5fc279a2f3d99011') THEN
  RAISE EXCEPTION 'Unqualified schema drift: files_upgrade_admission_ready';
 END IF;
END
$object_guard$;

REVOKE ALL ON FUNCTION public."files_upgrade_admission_ready"() FROM PUBLIC;

DO $pod_414$
BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN GRANT EXECUTE ON FUNCTION public."files_upgrade_admission_ready"() TO service_role; END IF;
END
$pod_414$;

DO $object_guard$
DECLARE actual text;
BEGIN
 SELECT definition INTO actual FROM (SELECT pg_get_functiondef(p.oid) definition FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='finalize_personal_agent_cloud_removal' AND pg_get_function_identity_arguments(p.oid)='owner_id text, attempt text, expected_digest text') observed;
 IF actual IS NULL THEN
  EXECUTE $object$CREATE OR REPLACE FUNCTION public.finalize_personal_agent_cloud_removal(owner_id text, attempt text, expected_digest text)
 RETURNS boolean
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE agent public.personal_agent_registry%ROWTYPE; op public.personal_agent_cloud_removals%ROWTYPE;
 r jsonb; history jsonb; removed_at timestamptz; replacement public.personal_agent_registry%ROWTYPE;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended(owner_id,171));
 PERFORM pg_advisory_xact_lock(hashtextextended(owner_id,198));
 IF public.personal_agent_cloud_removal_ready() IS NOT TRUE THEN RETURN false; END IF;
 SELECT * INTO op FROM public.personal_agent_cloud_removals WHERE user_id=owner_id AND attempt_id=attempt FOR UPDATE;
 IF NOT FOUND OR op.approved_digest IS DISTINCT FROM expected_digest OR expected_digest IS NULL THEN RETURN false; END IF;
 -- A lost response is recoverable only while its exact released identity is
 -- still current. A replacement never becomes "unplaced" through an old replay.
 IF op.completed_at IS NOT NULL THEN
  RETURN public.personal_agent_cloud_removal_replay_current(owner_id,attempt);
 END IF;
 IF public.personal_agent_erasure_complete(owner_id) IS NOT TRUE
 OR EXISTS(SELECT 1 FROM public.personal_agent_standby_placements WHERE user_id=owner_id) THEN RETURN false; END IF;
 SELECT * INTO agent FROM public.personal_agent_registry WHERE user_id=owner_id FOR UPDATE;
 r:=agent.backend_metadata->'erasure';
 IF r->>'attemptId' IS DISTINCT FROM attempt THEN RETURN false; END IF;
 SELECT authorization_attempts INTO history FROM public.byoc_setup_jobs WHERE user_id=owner_id FOR UPDATE;
 removed_at:=clock_timestamp();
 UPDATE public.personal_agent_cloud_removals SET completed_at=removed_at,
  archive=public.personal_agent_erasure_archive(r,history),
  released_identity=public.personal_agent_cloud_removal_identity(to_jsonb(agent),removed_at,attempt)
 WHERE user_id=owner_id AND attempt_id=attempt RETURNING * INTO op;
 IF public.personal_agent_erasure_archived(owner_id,r,history) IS NOT TRUE THEN
  RAISE EXCEPTION 'cloud removal archive unconfirmed' USING ERRCODE='42501'; END IF;
 DELETE FROM public.pod_lifecycle_events WHERE user_id=owner_id;
 DELETE FROM public.byoc_setup_jobs WHERE user_id=owner_id;
 DELETE FROM public.personal_agent_registry WHERE user_id=owner_id;
 replacement:=jsonb_populate_record(NULL::public.personal_agent_registry,op.released_identity);
 INSERT INTO public.personal_agent_registry SELECT replacement.*;
 RETURN true;
END;
$function$
$object$;
 ELSIF encode(sha256(convert_to(actual,'UTF8')),'hex') NOT IN ('da5f9deff4c3a6c0175639f40373bef33595e681390274561280b65117d88b30') THEN
  RAISE EXCEPTION 'Unqualified schema drift: finalize_personal_agent_cloud_removal';
 END IF;
END
$object_guard$;

REVOKE ALL ON FUNCTION public."finalize_personal_agent_cloud_removal"(text, text, text) FROM PUBLIC;

DO $pod_414$
BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN GRANT EXECUTE ON FUNCTION public."finalize_personal_agent_cloud_removal"(text, text, text) TO service_role; END IF;
END
$pod_414$;

DO $object_guard$
DECLARE actual text;
BEGIN
 SELECT definition INTO actual FROM (SELECT pg_get_functiondef(p.oid) definition FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='finalize_personal_agent_erasure' AND pg_get_function_identity_arguments(p.oid)='owner_id text') observed;
 IF actual IS NULL THEN
  EXECUTE $object$CREATE OR REPLACE FUNCTION public.finalize_personal_agent_erasure(owner_id text)
 RETURNS boolean
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE registry public.personal_agent_registry%ROWTYPE; history jsonb; archive jsonb;
BEGIN
 IF public.personal_agent_erasure_complete(owner_id) IS DISTINCT FROM true THEN RETURN false; END IF;
 IF NOT EXISTS (SELECT 1 FROM public.account_deletion_tombstones WHERE cleanup_intent_kind='full_account' AND user_id_hash='sha256:'||encode(sha256(convert_to(owner_id,'UTF8')),'hex')) THEN RETURN false; END IF;
 SELECT * INTO registry FROM public.personal_agent_registry WHERE user_id=owner_id;
 SELECT authorization_attempts INTO history FROM public.byoc_setup_jobs WHERE user_id=owner_id;
 archive:=public.personal_agent_erasure_archive(registry.backend_metadata->'erasure',history);
 IF NOT EXISTS (SELECT 1 FROM public.personal_agent_deletion_tombstones WHERE status='erasure_completed' AND metadata=archive) THEN
  INSERT INTO public.personal_agent_deletion_tombstones(hushh_id,external_agent_id,status,metadata)
  VALUES (registry.hushh_id,registry.external_agent_id,'erasure_completed',archive);
 END IF;
 IF public.personal_agent_erasure_archived(owner_id,registry.backend_metadata->'erasure',history) IS DISTINCT FROM true THEN
  RAISE EXCEPTION 'erasure archive unconfirmed' USING ERRCODE='42501'; END IF;
 DELETE FROM public.pod_lifecycle_events WHERE user_id=owner_id;
 DELETE FROM public.byoc_setup_jobs WHERE user_id=owner_id;
 DELETE FROM public.personal_agent_registry WHERE user_id=owner_id;
 IF EXISTS (SELECT 1 FROM public.personal_agent_registry WHERE user_id=owner_id)
 OR EXISTS (SELECT 1 FROM public.byoc_setup_jobs WHERE user_id=owner_id)
 OR EXISTS (SELECT 1 FROM public.pod_lifecycle_events WHERE user_id=owner_id)
 OR EXISTS (SELECT 1 FROM public.pod_migration_jobs WHERE user_id=owner_id) THEN
  RAISE EXCEPTION 'erasure finalization incomplete' USING ERRCODE='42501'; END IF;
 RETURN true;
END;
$function$
$object$;
 ELSIF encode(sha256(convert_to(actual,'UTF8')),'hex') NOT IN ('7180ef2869fdd45272beef18f8c9ee7927a1092f879a6acd0279e797b7d9bfb9') THEN
  RAISE EXCEPTION 'Unqualified schema drift: finalize_personal_agent_erasure';
 END IF;
END
$object_guard$;

REVOKE ALL ON FUNCTION public."finalize_personal_agent_erasure"(text) FROM PUBLIC;

DO $pod_414$
BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN GRANT EXECUTE ON FUNCTION public."finalize_personal_agent_erasure"(text) TO service_role; END IF;
END
$pod_414$;

DO $object_guard$
DECLARE actual text;
BEGIN
 SELECT definition INTO actual FROM (SELECT pg_get_functiondef(p.oid) definition FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='guard_azure_vm_power_deletion' AND pg_get_function_identity_arguments(p.oid)='') observed;
 IF actual IS NULL THEN
  EXECUTE $object$CREATE OR REPLACE FUNCTION public.guard_azure_vm_power_deletion()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE item jsonb:=CASE WHEN TG_OP='DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END;
 owner_id text; metadata jsonb;
BEGIN
 SELECT user_id INTO owner_id FROM personal_agent_registry
 WHERE (TG_TABLE_NAME='personal_agent_deletion_tombstones' AND hushh_id=item->>'hushh_id')
 OR (TG_TABLE_NAME='account_deletion_tombstones' AND item->>'cleanup_intent_kind'='full_account'
   AND item->>'user_id_hash'='sha256:'||encode(sha256(convert_to(user_id,'UTF8')),'hex'));
 IF owner_id IS NOT NULL THEN
  IF NOT pg_try_advisory_xact_lock(hashtextextended(owner_id,171))
    OR NOT pg_try_advisory_xact_lock(hashtextextended(owner_id,198)) THEN
   RAISE EXCEPTION 'VM deletion is busy' USING ERRCODE='42501';
  END IF;
  SELECT backend_metadata INTO metadata FROM personal_agent_registry WHERE user_id=owner_id FOR UPDATE;
  IF metadata->>'hostKind'='azure_vm'
   AND current_setting('transaction_isolation') NOT IN ('read committed','read uncommitted') THEN
   RAISE EXCEPTION 'VM deletion requires a current snapshot' USING ERRCODE='42501';
  END IF;
  IF public.azure_vm_power_pending(metadata) THEN
   RAISE EXCEPTION 'VM power requires reconciliation before deletion' USING ERRCODE='42501';
  END IF;
 END IF;
 RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END;
$function$
$object$;
 ELSIF encode(sha256(convert_to(actual,'UTF8')),'hex') NOT IN ('82bb4d47f292fd267ec16d7b2ce7ce7332e56dccabf023b35f73ced7bd34e3b5') THEN
  RAISE EXCEPTION 'Unqualified schema drift: guard_azure_vm_power_deletion';
 END IF;
END
$object_guard$;

REVOKE ALL ON FUNCTION public."guard_azure_vm_power_deletion"() FROM PUBLIC;

DO $pod_414$
BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN GRANT EXECUTE ON FUNCTION public."guard_azure_vm_power_deletion"() TO service_role; END IF;
END
$pod_414$;

DO $object_guard$
DECLARE actual text;
BEGIN
 SELECT definition INTO actual FROM (SELECT pg_get_functiondef(p.oid) definition FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='guard_azure_vm_power_registry' AND pg_get_function_identity_arguments(p.oid)='') observed;
 IF actual IS NULL THEN
  EXECUTE $object$CREATE OR REPLACE FUNCTION public.guard_azure_vm_power_registry()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE prior jsonb; incoming jsonb; binding jsonb;
BEGIN
 IF TG_OP='INSERT' THEN
  IF NEW.backend_metadata ? 'vmPower' THEN
   RAISE EXCEPTION 'VM power requires an existing installation' USING ERRCODE='42501';
  END IF;
  RETURN NEW;
 END IF;
 prior:=OLD.backend_metadata->'vmPower';
 -- Image/configuration publication is a distinct terminal transition. Check it
 -- before absent/unchanged power shortcuts, so stale ready markers cannot pass.
 IF TG_OP='UPDATE' AND OLD.backend_metadata->>'hostKind'='azure_vm' AND (
   OLD.backend_metadata->'image' IS DISTINCT FROM NEW.backend_metadata->'image'
   OR OLD.backend_metadata->'image_digest' IS DISTINCT FROM NEW.backend_metadata->'image_digest'
   OR OLD.backend_metadata->'vmHost' IS DISTINCT FROM NEW.backend_metadata->'vmHost'
   OR OLD.backend_metadata->'vmConfigurationSha256' IS DISTINCT FROM NEW.backend_metadata->'vmConfigurationSha256'
   OR (prior IS NOT NULL AND public.azure_vm_power_binding(to_jsonb(NEW)) IS DISTINCT FROM prior->'binding')
 ) THEN
  IF current_setting('transaction_isolation') NOT IN ('read committed','read uncommitted')
   OR NOT pg_try_advisory_xact_lock(hashtextextended(OLD.user_id,171))
   OR NOT pg_try_advisory_xact_lock(hashtextextended(OLD.user_id,198))
   OR NOT pg_try_advisory_xact_lock(hashtextextended(OLD.user_id,206))
   OR public.azure_vm_image_publication_proven(OLD,NEW) IS NOT TRUE
  THEN RAISE EXCEPTION 'VM image publication requires verified recovery' USING ERRCODE='42501'; END IF;
  RETURN NEW;
 END IF;
 IF prior IS NULL AND (TG_OP='DELETE' OR NOT coalesce(NEW.backend_metadata ? 'vmPower',false)) THEN
  RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
 END IF;
 IF current_setting('transaction_isolation') NOT IN ('read committed','read uncommitted') THEN
  RAISE EXCEPTION 'VM power requires a current snapshot' USING ERRCODE='42501';
 END IF;
 IF TG_OP='DELETE' THEN
  IF public.azure_vm_power_pending(OLD.backend_metadata) THEN
   RAISE EXCEPTION 'VM power requires reconciliation' USING ERRCODE='42501';
  END IF;
  RETURN OLD;
 END IF;
 incoming:=NEW.backend_metadata->'vmPower';
 IF public.azure_vm_power_pending(OLD.backend_metadata) AND (
   public.azure_vm_power_binding(to_jsonb(NEW)) IS DISTINCT FROM prior->'binding'
   OR NEW.backend_metadata ?| ARRAY['erasure','upgradeLease','provisionAttempt']
 ) THEN RAISE EXCEPTION 'VM power fences this installation' USING ERRCODE='42501'; END IF;
 IF incoming IS NOT DISTINCT FROM prior THEN RETURN NEW; END IF;
 IF NOT public.byoc_azure_worker_session_held(OLD.user_id)
 OR NOT pg_try_advisory_xact_lock(hashtextextended(OLD.user_id,171))
 OR NOT pg_try_advisory_xact_lock(hashtextextended(OLD.user_id,198)) THEN
  RAISE EXCEPTION 'VM power worker is not admitted' USING ERRCODE='42501';
 END IF;
 binding:=public.azure_vm_power_binding(to_jsonb(OLD));
 IF public.azure_vm_power_eligible(to_jsonb(OLD)) IS NOT TRUE
 OR public.azure_vm_power_binding(to_jsonb(NEW)) IS DISTINCT FROM binding
 OR (to_jsonb(NEW)-ARRAY['backend_metadata','updated_at'])
    IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['backend_metadata','updated_at'])
 OR NEW.backend_metadata-'vmPower' IS DISTINCT FROM OLD.backend_metadata-'vmPower'
 OR jsonb_typeof(incoming) IS DISTINCT FROM 'object'
 OR incoming-ARRAY['version','operationId','binding','phase','events','previousOperationId']<>'{}'::jsonb
 OR incoming->'version' IS DISTINCT FROM '1'::jsonb
 OR (incoming->>'phase' IN ('preparing','drained','deallocated','starting','recovered','ready')) IS NOT TRUE
 OR incoming->'binding' IS DISTINCT FROM binding
 OR coalesce(incoming->>'operationId','') !~ '^[a-f0-9]{32}$'
 OR jsonb_typeof(incoming->'events') IS DISTINCT FROM 'array'
 OR jsonb_array_length(incoming->'events')>16
 THEN RAISE EXCEPTION 'VM power transition refused' USING ERRCODE='42501'; END IF;
 IF prior IS NULL OR prior->>'phase'='ready' THEN
  IF incoming->>'phase' IS DISTINCT FROM 'preparing'
   OR incoming->'events' IS DISTINCT FROM '[]'::jsonb
   OR incoming->>'operationId'=prior->>'operationId'
   OR incoming->'previousOperationId' IS DISTINCT FROM prior->'operationId'
  THEN RAISE EXCEPTION 'VM power claim refused' USING ERRCODE='42501'; END IF;
 ELSE
  IF incoming-ARRAY['phase','events'] IS DISTINCT FROM prior-ARRAY['phase','events']
   OR (SELECT coalesce(jsonb_agg(value ORDER BY ordinal),'[]'::jsonb)
       FROM jsonb_array_elements(incoming->'events') WITH ORDINALITY e(value,ordinal)
       WHERE ordinal<=jsonb_array_length(prior->'events')) IS DISTINCT FROM prior->'events'
   OR (
     (incoming->>'phase'=prior->>'phase'
       AND jsonb_array_length(incoming->'events')=jsonb_array_length(prior->'events')+1
       AND public.valid_azure_vm_power_event(prior,incoming->'events'->-1))
     OR (incoming->'events'=prior->'events'
       AND public.azure_vm_power_phase_proven(prior,incoming->>'phase') AND (
       (prior->>'phase'='preparing' AND incoming->>'phase'='drained')
       OR (prior->>'phase'='drained' AND incoming->>'phase'='deallocated')
       OR (prior->>'phase'='deallocated' AND incoming->>'phase'='starting')
       OR (prior->>'phase'='starting' AND incoming->>'phase'='recovered')
       OR (prior->>'phase'='recovered' AND incoming->>'phase'='ready')))) IS NOT TRUE
  THEN RAISE EXCEPTION 'VM power receipt cannot be replaced' USING ERRCODE='42501'; END IF;
 END IF;
 RETURN NEW;
END;
$function$
$object$;
 ELSIF encode(sha256(convert_to(actual,'UTF8')),'hex') NOT IN ('1ab8202ca4ea3d52aa3d1e31aa9411db221e34a492d7ab63d5d8303fb7bea1c7') THEN
  RAISE EXCEPTION 'Unqualified schema drift: guard_azure_vm_power_registry';
 END IF;
END
$object_guard$;

REVOKE ALL ON FUNCTION public."guard_azure_vm_power_registry"() FROM PUBLIC;

DO $pod_414$
BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN GRANT EXECUTE ON FUNCTION public."guard_azure_vm_power_registry"() TO service_role; END IF;
END
$pod_414$;

DO $object_guard$
DECLARE actual text;
BEGIN
 SELECT definition INTO actual FROM (SELECT pg_get_functiondef(p.oid) definition FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='guard_azure_vm_power_standby' AND pg_get_function_identity_arguments(p.oid)='') observed;
 IF actual IS NULL THEN
  EXECUTE $object$CREATE OR REPLACE FUNCTION public.guard_azure_vm_power_standby()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE owner_id text:=CASE WHEN TG_OP='DELETE' THEN OLD.user_id ELSE NEW.user_id END; metadata jsonb;
BEGIN
 IF NOT pg_try_advisory_xact_lock(hashtextextended(owner_id,171))
 OR NOT pg_try_advisory_xact_lock(hashtextextended(owner_id,198)) THEN
  RAISE EXCEPTION 'VM placement is busy' USING ERRCODE='42501';
 END IF;
 SELECT backend_metadata INTO metadata FROM personal_agent_registry WHERE user_id=owner_id FOR UPDATE;
 IF metadata->>'hostKind'='azure_vm'
   AND current_setting('transaction_isolation') NOT IN ('read committed','read uncommitted') THEN
  RAISE EXCEPTION 'VM placement requires a current snapshot' USING ERRCODE='42501';
 END IF;
 IF public.azure_vm_power_pending(metadata) THEN
  RAISE EXCEPTION 'VM power requires reconciliation before standby changes' USING ERRCODE='42501';
 END IF;
 RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END;
$function$
$object$;
 ELSIF encode(sha256(convert_to(actual,'UTF8')),'hex') NOT IN ('7ca4cda4c1741810fcbf95e987a8652082df4ca49873f8892331e81027720ef6') THEN
  RAISE EXCEPTION 'Unqualified schema drift: guard_azure_vm_power_standby';
 END IF;
END
$object_guard$;

REVOKE ALL ON FUNCTION public."guard_azure_vm_power_standby"() FROM PUBLIC;

DO $pod_414$
BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN GRANT EXECUTE ON FUNCTION public."guard_azure_vm_power_standby"() TO service_role; END IF;
END
$pod_414$;

DO $object_guard$
DECLARE actual text;
BEGIN
 SELECT definition INTO actual FROM (SELECT pg_get_functiondef(p.oid) definition FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='guard_byoc_authorization_attempts' AND pg_get_function_identity_arguments(p.oid)='') observed;
 IF actual IS NULL THEN
  EXECUTE $object$CREATE OR REPLACE FUNCTION public.guard_byoc_authorization_attempts()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE k text; v jsonb; old_v jsonb; intent jsonb; receipt jsonb; binding jsonb; identity jsonb;
BEGIN
 IF TG_OP='DELETE' THEN
  IF public.personal_agent_erasure_archived(OLD.user_id,
    (SELECT backend_metadata->'erasure' FROM public.personal_agent_registry WHERE user_id=OLD.user_id),
    OLD.authorization_attempts) IS TRUE THEN RETURN OLD; END IF;
  IF OLD.authorization_attempts<>'{}'::jsonb THEN RAISE EXCEPTION 'authorization recovery retained' USING ERRCODE='42501'; END IF;
  RETURN OLD;
 END IF;
 IF TG_OP='INSERT' THEN
  IF NEW.authorization_attempts<>'{}'::jsonb THEN RAISE EXCEPTION 'authorization admission required' USING ERRCODE='42501'; END IF;
  RETURN NEW;
 END IF;
 IF NEW.user_id IS DISTINCT FROM OLD.user_id AND OLD.authorization_attempts<>'{}'::jsonb THEN RAISE EXCEPTION 'authorization owner immutable' USING ERRCODE='42501'; END IF;
 IF NEW.authorization_attempts=OLD.authorization_attempts THEN RETURN NEW; END IF;
 IF NEW.user_id IS DISTINCT FROM OLD.user_id OR jsonb_typeof(NEW.authorization_attempts) IS DISTINCT FROM 'object'
 OR NOT NEW.authorization_attempts ?& ARRAY(SELECT jsonb_object_keys(OLD.authorization_attempts)) THEN
  RAISE EXCEPTION 'authorization recovery immutable' USING ERRCODE='42501'; END IF;
 FOR k,v IN SELECT * FROM jsonb_each(NEW.authorization_attempts) LOOP
  old_v:=OLD.authorization_attempts->k;
  IF v=old_v THEN CONTINUE; END IF;
  intent:=v->'intent';
  IF old_v IS NULL THEN
   IF k IS DISTINCT FROM OLD.job_id OR OLD.status IS DISTINCT FROM 'running'
   OR v - 'intent'<>'{}'::jsonb OR jsonb_typeof(intent) IS DISTINCT FROM 'object'
   OR intent - ARRAY['ownerId','jobId','project','bootstrapEmail','callerEmail']<>'{}'::jsonb
   OR intent->>'ownerId' IS DISTINCT FROM OLD.user_id OR intent->>'jobId' IS DISTINCT FROM k
   OR intent->>'project' IS DISTINCT FROM OLD.project_id
   OR (intent->>'bootstrapEmail' ~ ('^[a-z][a-z0-9-]{4,28}[a-z0-9]@'||OLD.project_id||'\.iam\.gserviceaccount\.com$')) IS DISTINCT FROM true
   OR (intent->>'callerEmail' ~ '^[a-zA-Z0-9._-]+@[a-zA-Z0-9.-]+\.gserviceaccount\.com$') IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'authorization intent invalid' USING ERRCODE='42501'; END IF;
   PERFORM public.assert_project_grant_admission(OLD.project_id);
  ELSE
   receipt:=v->'receipt'; binding:=receipt->'bindingObservation'; identity:=receipt->'bootstrapIdentity';
   IF old_v ? 'receipt' OR v - 'receipt' IS DISTINCT FROM old_v
   OR jsonb_typeof(receipt) IS DISTINCT FROM 'object' OR receipt - ARRAY['bindingObservation','bootstrapIdentity']<>'{}'::jsonb
   OR jsonb_typeof(binding) IS DISTINCT FROM 'object' OR jsonb_typeof(identity) IS DISTINCT FROM 'object'
   OR identity->>'email' IS DISTINCT FROM intent->>'bootstrapEmail'
   OR identity->>'projectId' IS DISTINCT FROM intent->>'project'
   OR identity->>'name' IS DISTINCT FROM 'projects/'||(intent->>'project')||'/serviceAccounts/'||(intent->>'bootstrapEmail')
   OR (identity->>'uniqueId' ~ '^[0-9]{10,30}$') IS DISTINCT FROM true
   OR identity - ARRAY['name','projectId','email','uniqueId']<>'{}'::jsonb
   OR binding->>'step' IS DISTINCT FROM 'authorize_bootstrap_impersonation'
   OR binding->>'role' IS DISTINCT FROM 'roles/iam.serviceAccountTokenCreator'
   OR binding->>'member' IS DISTINCT FROM 'serviceAccount:'||(intent->>'callerEmail')
   OR binding->>'policyResource' IS DISTINCT FROM 'https://iam.googleapis.com/v1/projects/'||(intent->>'project')||'/serviceAccounts/'||(intent->>'bootstrapEmail')||':getIamPolicy'
   OR (binding->>'disposition' IN ('added','already_present')) IS DISTINCT FROM true
   OR coalesce(length(binding->>'beforeEtag'),0) NOT BETWEEN 1 AND 512
   OR coalesce(length(binding->>'afterEtag'),0) NOT BETWEEN 1 AND 512
   OR binding - ARRAY['step','policyResource','role','member','disposition','beforeEtag','afterEtag']<>'{}'::jsonb THEN
    RAISE EXCEPTION 'authorization receipt invalid' USING ERRCODE='42501'; END IF;
  END IF;
 END LOOP;
 RETURN NEW;
END;
$function$
$object$;
 ELSIF encode(sha256(convert_to(actual,'UTF8')),'hex') NOT IN ('21da621eb6d93ffed6c2df4d3ca287ccac2ec1cead0d0f94659fbb0b4fe41346') THEN
  RAISE EXCEPTION 'Unqualified schema drift: guard_byoc_authorization_attempts';
 END IF;
END
$object_guard$;

REVOKE ALL ON FUNCTION public."guard_byoc_authorization_attempts"() FROM PUBLIC;

DO $pod_414$
BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN GRANT EXECUTE ON FUNCTION public."guard_byoc_authorization_attempts"() TO service_role; END IF;
END
$pod_414$;

DO $object_guard$
DECLARE actual text;
BEGIN
 SELECT definition INTO actual FROM (SELECT pg_get_functiondef(p.oid) definition FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='guard_byoc_azure_erasure_job' AND pg_get_function_identity_arguments(p.oid)='') observed;
 IF actual IS NULL THEN
  EXECUTE $object$CREATE OR REPLACE FUNCTION public.guard_byoc_azure_erasure_job()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE reservation jsonb; owner_id text; previous_target text; item jsonb; history jsonb; agent public.personal_agent_registry%ROWTYPE; old_journal jsonb; new_journal jsonb;
BEGIN
 IF TG_OP='INSERT' THEN owner_id:=NEW.user_id; previous_target:=NEW.project_id;
 ELSE owner_id:=OLD.user_id; previous_target:=OLD.project_id; END IF;
 IF (previous_target LIKE '/subscriptions/%/resourceGroups/%') IS NOT TRUE
   AND (TG_OP='DELETE' OR (NEW.project_id LIKE '/subscriptions/%/resourceGroups/%') IS NOT TRUE)
 THEN
   IF TG_OP='DELETE' THEN RETURN OLD; END IF;
   RETURN NEW;
 END IF;
 IF TG_OP='UPDATE' AND NEW.user_id IS DISTINCT FROM OLD.user_id
 THEN RAISE EXCEPTION 'Azure setup owner is immutable' USING ERRCODE='42501'; END IF;
 -- A raw UPDATE already holds its job row. Never block on owner locks in that
 -- inverted order; refuse and retry under the normal owner-first entrypoint.
 IF NOT pg_try_advisory_xact_lock(hashtextextended(owner_id,171))
   OR NOT pg_try_advisory_xact_lock(hashtextextended(owner_id,198))
 THEN RAISE EXCEPTION 'Azure setup admission is busy' USING ERRCODE='42501'; END IF;
 SELECT * INTO agent FROM public.personal_agent_registry WHERE user_id=owner_id;
 reservation:=agent.backend_metadata->'erasure';
 IF TG_OP='UPDATE' THEN
   IF jsonb_typeof(NEW.stages) IS DISTINCT FROM 'array'
      OR public.byoc_azure_worker_history_has_capacity(NEW.stages) IS NOT TRUE
   THEN RAISE EXCEPTION 'Azure setup recovery requires reconciliation' USING ERRCODE='42501'; END IF;
   IF NEW.job_id=OLD.job_id THEN
    SELECT coalesce(jsonb_agg(x),'[]'::jsonb) INTO old_journal FROM jsonb_array_elements(OLD.stages) x
     WHERE x->>'stage' IN ('azure_worker_started','azure_worker_exited','azure_provider_request',
       'azure_provider_ack','azure_provider_terminal');
    SELECT coalesce(jsonb_agg(x),'[]'::jsonb) INTO new_journal FROM jsonb_array_elements(NEW.stages) x
     WHERE x->>'stage' IN ('azure_worker_started','azure_worker_exited','azure_provider_request',
       'azure_provider_ack','azure_provider_terminal');
    IF jsonb_array_length(new_journal)<jsonb_array_length(old_journal)
     OR jsonb_array_length(new_journal)>jsonb_array_length(old_journal)+1
     OR EXISTS (SELECT 1 FROM jsonb_array_elements(old_journal) WITH ORDINALITY entry(value,n)
       WHERE new_journal->((n-1)::integer) IS DISTINCT FROM entry.value)
    THEN RAISE EXCEPTION 'Azure worker history is immutable' USING ERRCODE='42501'; END IF;
    IF jsonb_array_length(new_journal)>jsonb_array_length(old_journal)
      AND public.valid_byoc_azure_worker_event(owner_id,OLD.job_id,new_journal->-1,OLD.stages,
        OLD.project_id,agent.hushh_id) IS NOT TRUE
    THEN RAISE EXCEPTION 'Azure worker receipt refused' USING ERRCODE='42501'; END IF;
   END IF;
 END IF;
 IF reservation IS NULL THEN
   IF TG_OP='INSERT' THEN
     IF EXISTS (SELECT 1 FROM jsonb_array_elements(NEW.stages) x
       WHERE x->>'stage' IN ('azure_setup_intent','azure_setup_prior_intent','azure_worker_started',
       'azure_worker_exited','azure_provider_request','azure_provider_ack','azure_provider_terminal'))
     THEN RAISE EXCEPTION 'Azure setup binding admission required' USING ERRCODE='42501'; END IF;
     RETURN NEW;
   END IF;
   SELECT coalesce(jsonb_agg(x),'[]'::jsonb) INTO history
     FROM jsonb_array_elements(OLD.stages) x
     WHERE x->>'stage' IN ('azure_setup_intent','azure_setup_prior_intent','azure_worker_started',
       'azure_worker_exited','azure_provider_request','azure_provider_ack','azure_provider_terminal');
   IF history='[]'::jsonb THEN
     IF TG_OP='DELETE' THEN RETURN OLD; END IF;
     RETURN NEW;
   END IF;
   -- An early eligibility refusal made only reads. Keep the journal unless
   -- 962 independently proves every worker exited and no ARM request existed.
   IF TG_OP='DELETE' THEN
    IF to_regprocedure('public.azure_setup_no_effects(text)') IS NOT NULL THEN
     IF pg_try_advisory_xact_lock(hashtextextended(owner_id,206))
      AND public.azure_setup_no_effects(owner_id) IS TRUE THEN RETURN OLD; END IF;
    END IF;
   END IF;
   IF TG_OP='DELETE' OR NEW.project_id IS DISTINCT FROM OLD.project_id
   THEN RAISE EXCEPTION 'Azure setup recovery retained' USING ERRCODE='42501'; END IF;
   IF NEW.job_id IS DISTINCT FROM OLD.job_id THEN
     IF OLD.status='running' THEN
       RAISE EXCEPTION 'Azure setup worker reconciliation required' USING ERRCODE='42501';
     END IF;
     IF EXISTS (SELECT 1 FROM jsonb_array_elements(NEW.stages) x
       WHERE x->>'stage' IN ('azure_setup_intent','azure_setup_prior_intent','azure_worker_started',
       'azure_worker_exited','azure_provider_request','azure_provider_ack','azure_provider_terminal'))
     THEN RAISE EXCEPTION 'Azure retry binding must be retained by admission' USING ERRCODE='42501'; END IF;
     FOR item IN SELECT value FROM jsonb_array_elements(history) LOOP
       NEW.stages:=NEW.stages||jsonb_build_array(CASE WHEN item->>'stage'='azure_setup_intent'
        THEN jsonb_set(item,'{stage}','"azure_setup_prior_intent"'::jsonb) ELSE item END);
     END LOOP;
   ELSE
     FOR item IN SELECT value FROM jsonb_array_elements(history) LOOP
       IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(NEW.stages) x WHERE x=item)
       THEN RAISE EXCEPTION 'Azure setup recovery immutable' USING ERRCODE='42501'; END IF;
     END LOOP;
   END IF;
   IF NEW.stages IS DISTINCT FROM OLD.stages AND (
     (SELECT count(*) FROM jsonb_array_elements(NEW.stages) x
       WHERE x->>'stage' IN ('azure_setup_intent','azure_setup_prior_intent'))>64
     OR jsonb_array_length(NEW.stages)>2048 OR octet_length(NEW.stages::text)>1048576)
   THEN RAISE EXCEPTION 'Azure setup recovery requires reconciliation' USING ERRCODE='42501'; END IF;
   RETURN NEW;
 END IF;
 -- Existing admitted writes may report their actual outcome after erasure fences new work.
 IF TG_OP='UPDATE' AND to_jsonb(NEW)-ARRAY['stages','updated_at'] =
      to_jsonb(OLD)-ARRAY['stages','updated_at']
  AND jsonb_array_length(NEW.stages)=jsonb_array_length(OLD.stages)+1
  AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(OLD.stages) WITH ORDINALITY old_item(value,n)
    WHERE NEW.stages->((n-1)::integer) IS DISTINCT FROM old_item.value)
  AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(NEW.stages) WITH ORDINALITY added(value,n)
    WHERE n>jsonb_array_length(OLD.stages)
     AND (jsonb_typeof(added.value) IS DISTINCT FROM 'object' OR
       (added.value->>'stage' IN ('azure_provider_ack','azure_provider_terminal','azure_worker_exited')) IS NOT TRUE))
 THEN RETURN NEW; END IF;
 IF TG_OP='DELETE' AND public.personal_agent_erasure_archived(owner_id,reservation) IS TRUE
 THEN RETURN OLD; END IF;
 IF TG_OP='UPDATE'
   AND to_jsonb(NEW)-ARRAY['status','error_code','error_message','updated_at'] =
       to_jsonb(OLD)-ARRAY['status','error_code','error_message','updated_at']
   AND (NEW.status=OLD.status OR (OLD.status='running' AND NEW.status='failed'))
 THEN RETURN NEW; END IF;
 RAISE EXCEPTION 'Azure setup is fenced for erasure' USING ERRCODE='42501';
END;
$function$
$object$;
 ELSIF encode(sha256(convert_to(actual,'UTF8')),'hex') NOT IN ('b7bb6d93941cb1861c53331ca616e540cdf8f8551fb38c8034e1be713c4ff40e') THEN
  RAISE EXCEPTION 'Unqualified schema drift: guard_byoc_azure_erasure_job';
 END IF;
END
$object_guard$;

REVOKE ALL ON FUNCTION public."guard_byoc_azure_erasure_job"() FROM PUBLIC;

DO $pod_414$
BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN GRANT EXECUTE ON FUNCTION public."guard_byoc_azure_erasure_job"() TO service_role; END IF;
END
$pod_414$;

DO $object_guard$
DECLARE actual text;
BEGIN
 SELECT definition INTO actual FROM (SELECT pg_get_functiondef(p.oid) definition FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='guard_personal_agent_cloud_removal' AND pg_get_function_identity_arguments(p.oid)='') observed;
 IF actual IS NULL THEN
  EXECUTE $object$CREATE OR REPLACE FUNCTION public.guard_personal_agent_cloud_removal()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE owner_id text; agent public.personal_agent_registry%ROWTYPE; r jsonb; review jsonb; history jsonb;
BEGIN
 owner_id:=CASE WHEN TG_OP='DELETE' THEN OLD.user_id ELSE NEW.user_id END;
 PERFORM pg_advisory_xact_lock(hashtextextended(owner_id,171));
 PERFORM pg_advisory_xact_lock(hashtextextended(owner_id,198));
 -- Full account erasure explicitly removes these records in its own transaction.
 IF TG_OP='DELETE' THEN
  IF EXISTS(SELECT 1 FROM public.account_deletion_tombstones WHERE cleanup_intent_kind='full_account'
   AND user_id_hash='sha256:'||encode(sha256(convert_to(owner_id,'UTF8')),'hex')) THEN RETURN OLD; END IF;
  RAISE EXCEPTION 'cloud removal evidence retained' USING ERRCODE='42501';
 END IF;
 IF EXISTS(SELECT 1 FROM public.account_deletion_tombstones
  WHERE user_id_hash='sha256:'||encode(sha256(convert_to(owner_id,'UTF8')),'hex')) THEN
  RAISE EXCEPTION 'cloud removal owner deleted' USING ERRCODE='42501'; END IF;
 SELECT * INTO agent FROM public.personal_agent_registry WHERE user_id=owner_id FOR UPDATE;
 r:=agent.backend_metadata->'erasure';
 IF NOT FOUND OR agent.status IS DISTINCT FROM 'suspended' OR jsonb_typeof(r) IS DISTINCT FROM 'object'
 OR NEW.attempt_id IS DISTINCT FROM r->>'attemptId' OR r->>'ownerId' IS DISTINCT FROM owner_id
 OR NEW.placement_epoch IS DISTINCT FROM agent.placement_epoch
 OR NEW.snapshot_sha256 IS DISTINCT FROM encode(sha256(convert_to((r->'registrySnapshot')::text,'UTF8')),'hex') THEN
  RAISE EXCEPTION 'cloud removal placement changed' USING ERRCODE='42501'; END IF;
 IF TG_OP='INSERT' THEN
  IF NEW.approved_digest IS NOT NULL OR NEW.archive IS NOT NULL THEN
   RAISE EXCEPTION 'cloud removal approval required' USING ERRCODE='42501'; END IF;
  RETURN NEW;
 END IF;
 IF OLD.completed_at IS NOT NULL OR to_jsonb(NEW)-ARRAY['approved_digest','approved_at','completed_at','archive','released_identity']
  IS DISTINCT FROM to_jsonb(OLD)-ARRAY['approved_digest','approved_at','completed_at','archive','released_identity'] THEN
  RAISE EXCEPTION 'cloud removal evidence immutable' USING ERRCODE='42501'; END IF;
 review:=public.personal_agent_cloud_removal_review(r);
 IF NEW.approved_digest IS NULL OR NEW.approved_digest IS DISTINCT FROM encode(sha256(convert_to(review::text,'UTF8')),'hex')
 OR (NEW.archive IS NOT NULL AND (NEW.approved_digest IS DISTINCT FROM OLD.approved_digest
  OR NEW.approved_at IS DISTINCT FROM OLD.approved_at)) THEN
  RAISE EXCEPTION 'cloud removal approval changed' USING ERRCODE='42501'; END IF;
 IF NEW.archive IS NOT NULL THEN
  SELECT authorization_attempts INTO history FROM public.byoc_setup_jobs WHERE user_id=owner_id;
  IF public.personal_agent_erasure_complete(owner_id) IS NOT TRUE
  OR NEW.archive IS DISTINCT FROM public.personal_agent_erasure_archive(r,history)
  OR NEW.released_identity IS DISTINCT FROM public.personal_agent_cloud_removal_identity(to_jsonb(agent),NEW.completed_at,NEW.attempt_id) THEN
   RAISE EXCEPTION 'cloud removal completion unconfirmed' USING ERRCODE='42501'; END IF;
 END IF;
 RETURN NEW;
END;
$function$
$object$;
 ELSIF encode(sha256(convert_to(actual,'UTF8')),'hex') NOT IN ('8a40a11e26b479b3666b9627036671aa1ed8b34de209f094270de1ae69fcb80a','eb565a365d386bd85d2409c33edb11dadd152981ab8407a30dae40fadebd53b7') THEN
  RAISE EXCEPTION 'Unqualified schema drift: guard_personal_agent_cloud_removal';
 END IF;
END
$object_guard$;

REVOKE ALL ON FUNCTION public."guard_personal_agent_cloud_removal"() FROM PUBLIC;

DO $pod_414$
BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN GRANT EXECUTE ON FUNCTION public."guard_personal_agent_cloud_removal"() TO service_role; END IF;
END
$pod_414$;

DO $object_guard$
DECLARE actual text;
BEGIN
 SELECT definition INTO actual FROM (SELECT pg_get_functiondef(p.oid) definition FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='guard_personal_agent_cloud_removal_history' AND pg_get_function_identity_arguments(p.oid)='') observed;
 IF actual IS NULL THEN
  EXECUTE $object$CREATE OR REPLACE FUNCTION public.guard_personal_agent_cloud_removal_history()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE r jsonb; prior_placement jsonb;
BEGIN
 IF NEW.completed_at IS NULL THEN RETURN NEW; END IF;
 SELECT backend_metadata->'erasure' INTO r FROM public.personal_agent_registry WHERE user_id=NEW.user_id;
 FOR prior_placement IN SELECT * FROM jsonb_array_elements(coalesce(r->'registrySnapshot'->'backend_metadata'->'detachedPlacements','[]'::jsonb)) LOOP
  IF public.personal_agent_cloud_removal_covers(NEW.user_id,prior_placement) IS NOT TRUE
   AND public.notification_erasure_custody_archived(NEW.user_id,r,prior_placement) IS NOT TRUE THEN
   RAISE EXCEPTION 'cloud removal prior placement requires review' USING ERRCODE='42501'; END IF;
 END LOOP;
 RETURN NEW;
END;
$function$
$object$;
 ELSIF encode(sha256(convert_to(actual,'UTF8')),'hex') NOT IN ('b9d23dd2abe3920dc460c891a041720edf5ff71a511c7624660377be7e62e6f4') THEN
  RAISE EXCEPTION 'Unqualified schema drift: guard_personal_agent_cloud_removal_history';
 END IF;
END
$object_guard$;

REVOKE ALL ON FUNCTION public."guard_personal_agent_cloud_removal_history"() FROM PUBLIC;

DO $pod_414$
BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN GRANT EXECUTE ON FUNCTION public."guard_personal_agent_cloud_removal_history"() TO service_role; END IF;
END
$pod_414$;

DO $object_guard$
DECLARE actual text;
BEGIN
 SELECT definition INTO actual FROM (SELECT pg_get_functiondef(p.oid) definition FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='guard_personal_agent_erasure_archive' AND pg_get_function_identity_arguments(p.oid)='') observed;
 IF actual IS NULL THEN
  EXECUTE $object$CREATE OR REPLACE FUNCTION public.guard_personal_agent_erasure_archive()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE r jsonb; history jsonb; registry public.personal_agent_registry%ROWTYPE; owner_id text;
BEGIN
 IF TG_OP<>'INSERT' THEN
  IF OLD.status='erasure_completed' THEN RAISE EXCEPTION 'completed erasure archive immutable' USING ERRCODE='42501'; END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
 END IF;
 -- Serialize ordinary cleanup-marker creation with finalization as well.
 IF NEW.status IS DISTINCT FROM 'erasure_completed' THEN
  SELECT user_id INTO owner_id FROM public.personal_agent_registry WHERE hushh_id=NEW.hushh_id;
  IF owner_id IS NOT NULL THEN
   PERFORM pg_advisory_xact_lock(hashtextextended(owner_id,171));
   PERFORM pg_advisory_xact_lock(hashtextextended(owner_id,198));
  END IF;
  IF EXISTS (SELECT 1 FROM public.personal_agent_deletion_tombstones WHERE hushh_id=NEW.hushh_id AND status='erasure_completed') THEN
   RAISE EXCEPTION 'completed erasure cannot acquire a new cleanup request' USING ERRCODE='42501'; END IF;
 END IF;
 IF NEW.status='erasure_completed' THEN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'erasure archive requires validated insert' USING ERRCODE='42501'; END IF;
  owner_id:=NEW.metadata->>'ownerId';
  IF NOT EXISTS (SELECT 1 FROM public.account_deletion_tombstones WHERE cleanup_intent_kind='full_account' AND user_id_hash='sha256:'||encode(sha256(convert_to(owner_id,'UTF8')),'hex'))
   OR public.personal_agent_erasure_complete(owner_id) IS DISTINCT FROM true THEN
   RAISE EXCEPTION 'erasure archive authority incomplete' USING ERRCODE='42501'; END IF;
  SELECT * INTO registry FROM public.personal_agent_registry WHERE user_id=owner_id;
  SELECT authorization_attempts INTO history FROM public.byoc_setup_jobs WHERE user_id=owner_id;
  r:=registry.backend_metadata->'erasure';
  IF NEW.hushh_id IS DISTINCT FROM registry.hushh_id OR NEW.external_agent_id IS DISTINCT FROM registry.external_agent_id
   OR NEW.metadata IS DISTINCT FROM public.personal_agent_erasure_archive(r,history) THEN
   RAISE EXCEPTION 'erasure archive evidence mismatch' USING ERRCODE='42501'; END IF;
 END IF;
 RETURN NEW;
END;
$function$
$object$;
 ELSIF encode(sha256(convert_to(actual,'UTF8')),'hex') NOT IN ('b9710ebeeee3de3257e2617ed78871079326455c09f035267a389c36724d9d6a') THEN
  RAISE EXCEPTION 'Unqualified schema drift: guard_personal_agent_erasure_archive';
 END IF;
END
$object_guard$;

REVOKE ALL ON FUNCTION public."guard_personal_agent_erasure_archive"() FROM PUBLIC;

DO $pod_414$
BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN GRANT EXECUTE ON FUNCTION public."guard_personal_agent_erasure_archive"() TO service_role; END IF;
END
$pod_414$;

DO $object_guard$
DECLARE actual text;
BEGIN
 SELECT definition INTO actual FROM (SELECT pg_get_functiondef(p.oid) definition FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='guard_personal_agent_erasure_grant' AND pg_get_function_identity_arguments(p.oid)='') observed;
 IF actual IS NULL THEN
  EXECUTE $object$CREATE OR REPLACE FUNCTION public.guard_personal_agent_erasure_grant()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
BEGIN
  -- Existing account guard takes shared owner locks before this trigger. The
  -- reservation takes those locks exclusively, in the same 171 -> 198 order.
  IF NEW.agent_id = 'personal_agent' AND NEW.action = 'CONSENT_GRANTED' AND EXISTS (
    SELECT 1 FROM public.personal_agent_registry
    WHERE user_id = NEW.user_id AND backend_metadata ? 'erasure'
  ) THEN
    RAISE EXCEPTION 'personal agent erasure reserved' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$function$
$object$;
 ELSIF encode(sha256(convert_to(actual,'UTF8')),'hex') NOT IN ('80f619a048b339f2d396a0e717e77156db338b658a9609cb4ba6a24e2148f779') THEN
  RAISE EXCEPTION 'Unqualified schema drift: guard_personal_agent_erasure_grant';
 END IF;
END
$object_guard$;

REVOKE ALL ON FUNCTION public."guard_personal_agent_erasure_grant"() FROM PUBLIC;

DO $pod_414$
BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN GRANT EXECUTE ON FUNCTION public."guard_personal_agent_erasure_grant"() TO service_role; END IF;
END
$pod_414$;

DO $object_guard$
DECLARE actual text;
BEGIN
 SELECT definition INTO actual FROM (SELECT pg_get_functiondef(p.oid) definition FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='guard_personal_agent_erasure_registry' AND pg_get_function_identity_arguments(p.oid)='') observed;
 IF actual IS NULL THEN
  EXECUTE $object$CREATE OR REPLACE FUNCTION public.guard_personal_agent_erasure_registry()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE reservation jsonb; snapshot jsonb;
BEGIN
  IF TG_OP='DELETE' AND public.personal_agent_erasure_archived(OLD.user_id,OLD.backend_metadata->'erasure') IS TRUE THEN RETURN OLD; END IF;
  IF OLD.backend_metadata ? 'erasure' THEN
    reservation := OLD.backend_metadata->'erasure';
    snapshot := reservation->'registrySnapshot';

    -- 962: one validated append to the existing owner resource-cleanup receipt.
    IF TG_OP='UPDATE' AND to_jsonb(NEW)-'backend_metadata'=to_jsonb(OLD)-'backend_metadata'
       AND NEW.backend_metadata-'erasure'=OLD.backend_metadata-'erasure'
       AND public.valid_azure_erasure_append(OLD.user_id,OLD.backend_metadata->'erasure',
           NEW.backend_metadata->'erasure') IS TRUE THEN RETURN NEW; END IF;

    -- 956: one qualified receipt for the exact notification mutation frozen by erasure.
    IF TG_OP='UPDATE' AND to_jsonb(NEW)-'backend_metadata'=to_jsonb(OLD)-'backend_metadata'
       AND NEW.backend_metadata-'erasure'=OLD.backend_metadata-'erasure'
       AND (NEW.backend_metadata->'erasure')-'lateNotificationObservation'=OLD.backend_metadata->'erasure'
       AND NOT (OLD.backend_metadata->'erasure' ? 'lateNotificationObservation')
       AND NOT (OLD.backend_metadata->'erasure' ? 'substrateInventory')
       AND public.valid_erasure_notification_observation(OLD.backend_metadata->'erasure',
           NEW.backend_metadata->'erasure'->'lateNotificationObservation') IS TRUE THEN RETURN NEW; END IF;

    IF TG_OP='UPDATE'
       AND to_jsonb(NEW)-'backend_metadata'=to_jsonb(OLD)-'backend_metadata'
       AND NEW.backend_metadata-'erasure'=OLD.backend_metadata-'erasure'
       AND (NEW.backend_metadata->'erasure')-'lateFilesUpgradeObservation'=OLD.backend_metadata->'erasure'
       AND NOT (OLD.backend_metadata->'erasure' ? 'lateFilesUpgradeObservation')
       AND NOT (OLD.backend_metadata->'erasure' ? 'substrateInventory')
       AND public.valid_erasure_files_upgrade_observation(OLD.backend_metadata->'erasure',
           NEW.backend_metadata->'erasure'->'lateFilesUpgradeObservation') IS TRUE THEN RETURN NEW;
    END IF;

    -- The transaction-local marker coordinates the restore, but is caller-settable.
    -- Independently enforce the identity, tombstone and setup barriers here.
    IF TG_OP = 'UPDATE'
       AND current_setting('hussh.erasure_restore_attempt', true) = reservation->>'attemptId'
       AND reservation - ARRAY['version','ownerId','attemptId','hushhId','phase','registrySnapshot'] = '{}'::jsonb
       AND reservation->>'ownerId' = OLD.user_id
       AND OLD.status = 'suspended'
       AND snapshot->>'user_id' = OLD.user_id
       AND snapshot->>'hushh_id' = OLD.hushh_id
       AND reservation->>'phase' = 'reserved'
       AND snapshot->>'status' = 'provisioned'
       AND jsonb_typeof(snapshot->'backend_metadata') = 'object'
       AND NOT (snapshot->'backend_metadata' ? 'erasure')
       AND to_jsonb(NEW) - 'updated_at' = snapshot - 'updated_at'
    THEN
      IF current_setting('transaction_isolation') NOT IN ('read committed','read uncommitted') THEN
        RAISE EXCEPTION 'erasure restore requires a current snapshot' USING ERRCODE='42501';
      END IF;
      -- Match account erasure's owner-lock order. A direct writer holding the row
      -- must refuse a lock conflict rather than invert that order and deadlock.
      IF NOT pg_try_advisory_xact_lock(hashtextextended(OLD.user_id,171))
         OR NOT pg_try_advisory_xact_lock(hashtextextended(OLD.user_id,198)) THEN
        RAISE EXCEPTION 'erasure restore owner busy' USING ERRCODE='42501';
      END IF;
      IF EXISTS (SELECT 1 FROM public.personal_agent_deletion_tombstones WHERE hushh_id=OLD.hushh_id)
         OR EXISTS (SELECT 1 FROM public.account_deletion_tombstones
            WHERE user_id_hash='sha256:'||encode(sha256(convert_to(OLD.user_id,'UTF8')),'hex'))
         OR NOT EXISTS (SELECT 1 FROM public.byoc_setup_jobs
            WHERE user_id=OLD.user_id AND status='recorded' AND authorization_attempts='{}'::jsonb) THEN
        RAISE EXCEPTION 'erasure restore authority unavailable' USING ERRCODE='42501';
      END IF;
      RETURN NEW;
    END IF;

    IF TG_OP='UPDATE' AND to_jsonb(NEW)-'backend_metadata'=to_jsonb(OLD)-'backend_metadata'
       AND NEW.backend_metadata-'erasure'=OLD.backend_metadata-'erasure'
       AND public.valid_erasure_files_append(OLD.backend_metadata->'erasure',NEW.backend_metadata->'erasure') IS TRUE THEN RETURN NEW; END IF;
    -- Only a bound late acknowledgement may be appended. It is not a terminal
    -- cleanup result and cannot alter identity, custody, status or the reservation.
    IF TG_OP = 'UPDATE'
       AND to_jsonb(NEW) - 'backend_metadata' = to_jsonb(OLD) - 'backend_metadata'
       AND NEW.backend_metadata - 'erasure' = OLD.backend_metadata - 'erasure'
       AND (NEW.backend_metadata->'erasure') - 'lateUpgradeAcknowledgement' =
           (OLD.backend_metadata->'erasure') - 'lateUpgradeAcknowledgement'
       AND NOT ((OLD.backend_metadata->'erasure') ? 'lateUpgradeAcknowledgement')
       AND public.valid_erasure_upgrade_ack(
           OLD.backend_metadata->'erasure', NEW.backend_metadata->'erasure'->'lateUpgradeAcknowledgement') THEN
      RETURN NEW;
    END IF;
    IF TG_OP = 'UPDATE'
       AND to_jsonb(NEW) - 'backend_metadata' = to_jsonb(OLD) - 'backend_metadata'
       AND NEW.backend_metadata - 'erasure' = OLD.backend_metadata - 'erasure'
       AND (NEW.backend_metadata->'erasure') - 'lateProvisionAcknowledgement' =
           (OLD.backend_metadata->'erasure') - 'lateProvisionAcknowledgement'
       AND NOT ((OLD.backend_metadata->'erasure') ? 'lateProvisionAcknowledgement')
       AND public.valid_erasure_provision_ack(OLD.backend_metadata->'erasure',
           NEW.backend_metadata->'erasure'->'lateProvisionAcknowledgement') THEN
      RETURN NEW;
    END IF;
    IF TG_OP = 'UPDATE'
       AND to_jsonb(NEW) - 'backend_metadata' = to_jsonb(OLD) - 'backend_metadata'
       AND NEW.backend_metadata - 'erasure' = OLD.backend_metadata - 'erasure'
       AND (NEW.backend_metadata->'erasure') - 'memoryBinding' =
           (OLD.backend_metadata->'erasure') - 'memoryBinding'
       AND NOT ((OLD.backend_metadata->'erasure') ? 'memoryBinding')
       AND public.valid_erasure_memory_binding(OLD.backend_metadata->'erasure',
           NEW.backend_metadata->'erasure'->'memoryBinding') THEN
      RETURN NEW;
    END IF;
    IF TG_OP = 'UPDATE'
       AND to_jsonb(NEW) - 'backend_metadata' = to_jsonb(OLD) - 'backend_metadata'
       AND NEW.backend_metadata - 'erasure' = OLD.backend_metadata - 'erasure'
       AND (NEW.backend_metadata->'erasure') - 'memoryDeletion' = (OLD.backend_metadata->'erasure') - 'memoryDeletion'
       AND NOT ((OLD.backend_metadata->'erasure') ? 'memoryDeletion')
       AND public.valid_erasure_memory_deletion(OLD.backend_metadata->'erasure',
           NEW.backend_metadata->'erasure'->'memoryDeletion') THEN RETURN NEW;
    END IF;
    IF TG_OP = 'UPDATE'
       AND to_jsonb(NEW) - 'backend_metadata' = to_jsonb(OLD) - 'backend_metadata'
       AND NEW.backend_metadata - 'erasure' = OLD.backend_metadata - 'erasure'
       AND public.valid_erasure_compute_append(OLD.backend_metadata->'erasure',NEW.backend_metadata->'erasure') THEN
      RETURN NEW;
    END IF;
    IF TG_OP = 'UPDATE'
       AND to_jsonb(NEW) - 'backend_metadata' = to_jsonb(OLD) - 'backend_metadata'
       AND NEW.backend_metadata - 'erasure' = OLD.backend_metadata - 'erasure'
       AND NOT (OLD.backend_metadata->'erasure' ? 'substrateInventory')
       AND (NEW.backend_metadata->'erasure') - 'substrateInventory' = OLD.backend_metadata->'erasure'
       AND public.valid_erasure_substrate_inventory(OLD.backend_metadata->'erasure',
           NEW.backend_metadata->'erasure'->'substrateInventory') THEN RETURN NEW;
    END IF;
    IF TG_OP = 'UPDATE'
       AND to_jsonb(NEW) - 'backend_metadata' = to_jsonb(OLD) - 'backend_metadata'
       AND NEW.backend_metadata - 'erasure' = OLD.backend_metadata - 'erasure'
       AND public.valid_erasure_writer_append(OLD.backend_metadata->'erasure',NEW.backend_metadata->'erasure') THEN
      RETURN NEW;
    END IF;
    IF TG_OP = 'UPDATE'
       AND to_jsonb(NEW) - 'backend_metadata' = to_jsonb(OLD) - 'backend_metadata'
       AND NEW.backend_metadata - 'erasure' = OLD.backend_metadata - 'erasure'
       AND public.valid_erasure_bucket_append(OLD.backend_metadata->'erasure',NEW.backend_metadata->'erasure') THEN
      RETURN NEW;
    END IF;
    IF TG_OP = 'UPDATE'
       AND to_jsonb(NEW) - 'backend_metadata' = to_jsonb(OLD) - 'backend_metadata'
       AND NEW.backend_metadata - 'erasure' = OLD.backend_metadata - 'erasure'
       AND public.valid_erasure_mail_append(OLD.backend_metadata->'erasure',NEW.backend_metadata->'erasure') THEN RETURN NEW; END IF;
    IF TG_OP = 'UPDATE'
       AND to_jsonb(NEW) - 'backend_metadata' = to_jsonb(OLD) - 'backend_metadata'
       AND NEW.backend_metadata - 'erasure' = OLD.backend_metadata - 'erasure'
       AND public.valid_erasure_kms_append(OLD.backend_metadata->'erasure',NEW.backend_metadata->'erasure') THEN RETURN NEW;
    END IF;
    IF TG_OP = 'UPDATE'
       AND to_jsonb(NEW) - 'backend_metadata' = to_jsonb(OLD) - 'backend_metadata'
       AND NEW.backend_metadata - 'erasure' = OLD.backend_metadata - 'erasure'
       AND public.valid_erasure_secret_append(OLD.backend_metadata->'erasure',NEW.backend_metadata->'erasure') THEN RETURN NEW;
    END IF;
    IF TG_OP = 'UPDATE'
       AND to_jsonb(NEW) - 'backend_metadata' = to_jsonb(OLD) - 'backend_metadata'
       AND NEW.backend_metadata - 'erasure' = OLD.backend_metadata - 'erasure'
       AND public.valid_erasure_account_append(OLD.backend_metadata->'erasure',NEW.backend_metadata->'erasure') THEN RETURN NEW;
    END IF;
    IF TG_OP = 'UPDATE'
       AND to_jsonb(NEW) - 'backend_metadata' = to_jsonb(OLD) - 'backend_metadata'
       AND NEW.backend_metadata - 'erasure' = OLD.backend_metadata - 'erasure'
       AND NOT (OLD.backend_metadata->'erasure' ? 'grantRelease')
       AND (NEW.backend_metadata->'erasure') - 'grantRelease'=OLD.backend_metadata->'erasure'
       AND public.valid_erasure_grant_release(OLD.backend_metadata->'erasure',NEW.backend_metadata->'erasure'->'grantRelease') IS TRUE
       AND public.project_grant_release_is_exclusive(OLD.user_id,NEW.backend_metadata->'erasure'->'grantRelease'->>'project') IS TRUE THEN RETURN NEW;
    END IF;
    IF TG_OP='UPDATE' AND to_jsonb(NEW)-'backend_metadata'=to_jsonb(OLD)-'backend_metadata'
       AND NEW.backend_metadata-'erasure'=OLD.backend_metadata-'erasure'
       AND public.valid_erasure_runtime_grant_append(OLD.backend_metadata->'erasure',NEW.backend_metadata->'erasure') IS TRUE
       AND public.project_grant_release_is_exclusive(OLD.user_id,OLD.backend_metadata->'erasure'->'grantRelease'->>'project') IS TRUE THEN RETURN NEW; END IF;
    IF TG_OP = 'UPDATE'
       AND to_jsonb(NEW) - 'backend_metadata' = to_jsonb(OLD) - 'backend_metadata'
       AND NEW.backend_metadata - 'erasure' = OLD.backend_metadata - 'erasure'
       AND public.valid_erasure_repository_grant_append(OLD.backend_metadata->'erasure',NEW.backend_metadata->'erasure') IS TRUE
       AND public.project_grant_release_is_exclusive(OLD.user_id,OLD.backend_metadata->'erasure'->'grantRelease'->>'project') IS TRUE THEN RETURN NEW; END IF;
    IF TG_OP='UPDATE' AND to_jsonb(NEW)-'backend_metadata'=to_jsonb(OLD)-'backend_metadata'
       AND NEW.backend_metadata-'erasure'=OLD.backend_metadata-'erasure'
       AND NOT (OLD.backend_metadata->'erasure' ? 'repositoryInventory')
       AND (NEW.backend_metadata->'erasure')-'repositoryInventory'=OLD.backend_metadata->'erasure'
       AND public.valid_erasure_repository_inventory(OLD.backend_metadata->'erasure',NEW.backend_metadata->'erasure'->'repositoryInventory') IS TRUE
       AND public.project_grant_release_is_exclusive(OLD.user_id,OLD.backend_metadata->'erasure'->'grantRelease'->>'project') IS TRUE THEN RETURN NEW; END IF;
    IF TG_OP='UPDATE' AND to_jsonb(NEW)-'backend_metadata'=to_jsonb(OLD)-'backend_metadata'
       AND NEW.backend_metadata-'erasure'=OLD.backend_metadata-'erasure'
       AND NOT (OLD.backend_metadata->'erasure' ? 'repositoryRetention')
       AND (NEW.backend_metadata->'erasure')-'repositoryRetention'=OLD.backend_metadata->'erasure'
       AND public.valid_erasure_repository_retention(OLD.backend_metadata->'erasure',NEW.backend_metadata->'erasure'->'repositoryRetention') IS TRUE
       AND public.project_grant_release_is_exclusive(OLD.user_id,OLD.backend_metadata->'erasure'->'grantRelease'->>'project') IS TRUE THEN RETURN NEW; END IF;
    IF TG_OP='UPDATE' AND to_jsonb(NEW)-'backend_metadata'=to_jsonb(OLD)-'backend_metadata'
       AND NEW.backend_metadata-'erasure'=OLD.backend_metadata-'erasure'
       AND NOT (OLD.backend_metadata->'erasure' ? 'bootstrapGrantRelease')
       AND (NEW.backend_metadata->'erasure')-'bootstrapGrantRelease'=OLD.backend_metadata->'erasure'
       AND NEW.backend_metadata->'erasure'->'bootstrapGrantRelease'=public.expected_erasure_bootstrap_release(OLD.user_id,OLD.backend_metadata->'erasure',NEW.backend_metadata->'erasure'->'bootstrapGrantRelease'->>'recoveryMember')
       AND public.project_grant_release_is_exclusive(OLD.user_id,OLD.backend_metadata->'erasure'->'grantRelease'->>'project') IS TRUE THEN RETURN NEW; END IF;
    IF TG_OP='UPDATE' AND to_jsonb(NEW)-'backend_metadata'=to_jsonb(OLD)-'backend_metadata'
       AND NEW.backend_metadata-'erasure'=OLD.backend_metadata-'erasure'
       AND public.valid_erasure_bootstrap_append(OLD.backend_metadata->'erasure',NEW.backend_metadata->'erasure') IS TRUE
       AND public.project_grant_release_is_exclusive(OLD.user_id,OLD.backend_metadata->'erasure'->'grantRelease'->>'project') IS TRUE THEN RETURN NEW; END IF;
    -- Owner-access erasure (949): the pod's confirmation, once, before any revocation.
    IF TG_OP='UPDATE' AND to_jsonb(NEW)-'backend_metadata'=to_jsonb(OLD)-'backend_metadata'
       AND NEW.backend_metadata-'erasure'=OLD.backend_metadata-'erasure'
       AND NOT (OLD.backend_metadata->'erasure' ? 'agentCryptoErase')
       AND NOT (OLD.backend_metadata->'erasure' ? 'ownerAccessErasure')
       AND (NEW.backend_metadata->'erasure')-'agentCryptoErase'=OLD.backend_metadata->'erasure'
       AND public.valid_erasure_owner_access_checkpoint(OLD.backend_metadata->'erasure',
           NEW.backend_metadata->'erasure'->'agentCryptoErase') IS TRUE THEN RETURN NEW; END IF;
    -- Owner-access erasure (949): one receipt, once, validated against the snapshot.
    IF TG_OP='UPDATE' AND to_jsonb(NEW)-'backend_metadata'=to_jsonb(OLD)-'backend_metadata'
       AND NEW.backend_metadata-'erasure'=OLD.backend_metadata-'erasure'
       AND NOT (OLD.backend_metadata->'erasure' ? 'ownerAccessErasure')
       AND (NEW.backend_metadata->'erasure')-'ownerAccessErasure'=OLD.backend_metadata->'erasure'
       AND public.valid_erasure_owner_access(OLD.backend_metadata->'erasure',
           NEW.backend_metadata->'erasure'->'ownerAccessErasure') IS TRUE THEN RETURN NEW; END IF;
    -- Never-hosted erasure (954): the derived receipt and the project fence, once.
    IF TG_OP='UPDATE' AND to_jsonb(NEW)-'backend_metadata'=to_jsonb(OLD)-'backend_metadata'
       AND NEW.backend_metadata-'erasure'=OLD.backend_metadata-'erasure'
       AND public.valid_erasure_never_hosted_append(OLD.user_id,OLD.backend_metadata->'erasure',
           NEW.backend_metadata->'erasure') IS TRUE
       AND public.project_grant_release_is_exclusive(OLD.user_id,
           NEW.backend_metadata->'erasure'->'grantRelease'->>'project') IS TRUE THEN RETURN NEW; END IF;
    RAISE EXCEPTION 'personal agent erasure reserved' USING ERRCODE = '42501';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$function$
$object$;
 ELSIF encode(sha256(convert_to(actual,'UTF8')),'hex') NOT IN ('28050839ef93e010d92cd5289dda40b6adb020aaf3717f4b23c513aa4503f30a','c7f509dc6824e9a0ab66ae6e30b98e2afdd48483d72754a00c36cb15d0d3f521') THEN
  RAISE EXCEPTION 'Unqualified schema drift: guard_personal_agent_erasure_registry';
 END IF;
END
$object_guard$;

REVOKE ALL ON FUNCTION public."guard_personal_agent_erasure_registry"() FROM PUBLIC;

DO $pod_414$
BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN GRANT EXECUTE ON FUNCTION public."guard_personal_agent_erasure_registry"() TO service_role; END IF;
END
$pod_414$;

DO $object_guard$
DECLARE actual text;
BEGIN
 SELECT definition INTO actual FROM (SELECT pg_get_functiondef(p.oid) definition FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='guard_personal_agent_notification_registry' AND pg_get_function_identity_arguments(p.oid)='') observed;
 IF actual IS NULL THEN
  EXECUTE $object$CREATE OR REPLACE FUNCTION public.guard_personal_agent_notification_registry()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE previous jsonb:=OLD.backend_metadata->'notificationCheckpoint'; candidate jsonb:=NEW.backend_metadata->'notificationCheckpoint';
BEGIN
 IF OLD.backend_metadata ? 'erasure' THEN RETURN NEW; END IF;
 IF public.notification_initial_host_binding(to_jsonb(OLD),to_jsonb(NEW)) IS TRUE THEN
  IF public.operator_topic_custody_preserved(OLD.backend_metadata,NEW.backend_metadata) IS DISTINCT FROM true
  THEN RAISE EXCEPTION 'operator notification custody not retained' USING ERRCODE='42501'; END IF;
  RETURN NEW;
 END IF;
 -- 956: host custody may move a completed checkpoint, but cannot move an in-flight mutation.
 IF (previous IS NOT NULL OR candidate IS NOT NULL) AND (NEW.external_agent_id IS DISTINCT FROM OLD.external_agent_id
   OR NEW.deployment_target IS DISTINCT FROM OLD.deployment_target OR NEW.user_cloud_project IS DISTINCT FROM OLD.user_cloud_project
   OR NEW.user_cloud_region IS DISTINCT FROM OLD.user_cloud_region
   OR NEW.backend_metadata->>'serviceUid' IS DISTINCT FROM OLD.backend_metadata->>'serviceUid') THEN
  IF (previous IS NOT NULL AND previous->>'phase' IS DISTINCT FROM 'observed') OR OLD.status NOT IN ('provisioned','needs_reinit')
   OR OLD.backend_metadata ? 'upgradeLease'
   OR (OLD.backend_metadata ? 'provisionAttempt' AND OLD.backend_metadata->'provisionAttempt'->>'phase' IS DISTINCT FROM 'provisioned')
   OR NEW.user_id IS DISTINCT FROM OLD.user_id OR NEW.hushh_id IS DISTINCT FROM OLD.hushh_id
   OR (candidate IS NOT NULL AND (candidate->>'phase' IS DISTINCT FROM 'observed'
       OR NOT EXISTS(SELECT 1 FROM public.personal_agent_standby_placements standby WHERE standby.user_id=OLD.user_id AND standby.hushh_id=OLD.hushh_id
         AND standby.backend_metadata->'notificationCheckpoint'=candidate
         AND standby.external_agent_id=NEW.external_agent_id AND standby.deployment_target=NEW.deployment_target
         AND standby.user_cloud_project IS NOT DISTINCT FROM NEW.user_cloud_project AND standby.user_cloud_region IS NOT DISTINCT FROM NEW.user_cloud_region
         AND standby.pod_pubkey IS NOT DISTINCT FROM NEW.pod_pubkey AND standby.pod_key_id IS NOT DISTINCT FROM NEW.pod_key_id
         AND standby.pod_signing_pubkey IS NOT DISTINCT FROM NEW.pod_signing_pubkey AND standby.pod_signing_key_id IS NOT DISTINCT FROM NEW.pod_signing_key_id)
       OR candidate->>'ownerId' IS DISTINCT FROM NEW.user_id
       OR candidate->>'hushhId' IS DISTINCT FROM NEW.hushh_id OR candidate->>'project' IS DISTINCT FROM NEW.user_cloud_project
       OR candidate->>'region' IS DISTINCT FROM NEW.user_cloud_region
       OR candidate->'plan'->>'service' IS DISTINCT FROM NEW.external_agent_id
       OR (candidate->>'serviceUid' IS NOT NULL AND candidate->>'serviceUid' IS DISTINCT FROM NEW.backend_metadata->>'serviceUid')))
  THEN RAISE EXCEPTION 'notification checkpoint host transfer requires completed operation' USING ERRCODE='42501'; END IF;
  -- The deferred trigger below proves the old custody still exists after all swap CTEs finish.
  RETURN NEW;
 END IF;
 IF public.operator_topic_custody_preserved(OLD.backend_metadata,NEW.backend_metadata) IS DISTINCT FROM true
 THEN RAISE EXCEPTION 'operator notification custody not retained' USING ERRCODE='42501'; END IF;
 IF candidate IS DISTINCT FROM previous THEN
  -- The marker is caller-settable coordination, never authentication. Independently
  -- validate the owner operation, UID, generation and the exact derived inventory.
  IF current_setting('hussh.notification_generation',true) IS DISTINCT FROM coalesce(previous->>'generation','0')
   OR to_jsonb(NEW)-'backend_metadata' IS DISTINCT FROM to_jsonb(OLD)-'backend_metadata'
   OR NEW.backend_metadata-ARRAY['notificationCheckpoint','substrateReceipt'] IS DISTINCT FROM OLD.backend_metadata-ARRAY['notificationCheckpoint','substrateReceipt']
   OR public.valid_personal_agent_notification_checkpoint(to_jsonb(OLD),candidate,previous) IS DISTINCT FROM true
   OR NEW.backend_metadata->'substrateReceipt' IS DISTINCT FROM public.notification_checkpoint_inventory(OLD.backend_metadata->'substrateReceipt',candidate)
  THEN RAISE EXCEPTION 'notification checkpoint requires current owner operation' USING ERRCODE='42501'; END IF;
 END IF;
 RETURN NEW;
END;
$function$
$object$;
 ELSIF encode(sha256(convert_to(actual,'UTF8')),'hex') NOT IN ('0ee6155bfb54260812d521a9c2550f474b545238db810dbf8636ae2e15d0bb2d') THEN
  RAISE EXCEPTION 'Unqualified schema drift: guard_personal_agent_notification_registry';
 END IF;
END
$object_guard$;

REVOKE ALL ON FUNCTION public."guard_personal_agent_notification_registry"() FROM PUBLIC;

DO $pod_414$
BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN GRANT EXECUTE ON FUNCTION public."guard_personal_agent_notification_registry"() TO service_role; END IF;
END
$pod_414$;

DO $object_guard$
DECLARE actual text;
BEGIN
 SELECT definition INTO actual FROM (SELECT pg_get_functiondef(p.oid) definition FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='guard_personal_agent_notification_retention' AND pg_get_function_identity_arguments(p.oid)='') observed;
 IF actual IS NULL THEN
  EXECUTE $object$CREATE OR REPLACE FUNCTION public.guard_personal_agent_notification_retention()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE archived jsonb; retained_metadata jsonb; current_metadata jsonb; detached jsonb;
BEGIN
 SELECT backend_metadata INTO current_metadata FROM public.personal_agent_registry WHERE user_id=OLD.user_id AND hushh_id=OLD.hushh_id;
 -- Previously detached custody remains protected even when the primary has no checkpoint.
 FOR detached IN SELECT value FROM jsonb_array_elements(coalesce(OLD.backend_metadata->'detachedPlacements','[]'::jsonb)) LOOP
  IF detached->'backend_metadata'->'notificationCheckpoint' IS NOT NULL
   AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(current_metadata->'detachedPlacements','[]'::jsonb)) item WHERE item=detached)
   AND public.notification_erasure_custody_archived(OLD.user_id,OLD.backend_metadata->'erasure',detached) IS DISTINCT FROM true THEN
   RAISE EXCEPTION 'notification checkpoint detached custody not retained' USING ERRCODE='42501'; END IF;
 END LOOP;
 IF OLD.backend_metadata->'notificationCheckpoint' IS NULL OR OLD.backend_metadata ? 'erasure' THEN RETURN NEW; END IF;
 IF public.notification_initial_host_binding(to_jsonb(OLD),to_jsonb(NEW)) IS TRUE THEN RETURN NEW; END IF;
 IF NEW.external_agent_id IS NOT DISTINCT FROM OLD.external_agent_id AND NEW.deployment_target IS NOT DISTINCT FROM OLD.deployment_target
  AND NEW.user_cloud_project IS NOT DISTINCT FROM OLD.user_cloud_project AND NEW.user_cloud_region IS NOT DISTINCT FROM OLD.user_cloud_region
  AND NEW.backend_metadata->>'serviceUid' IS NOT DISTINCT FROM OLD.backend_metadata->>'serviceUid' THEN RETURN NEW; END IF;
 -- Re-read after transaction writes. A same-statement temporary archive is not retention.
 SELECT backend_metadata INTO current_metadata FROM public.personal_agent_registry WHERE user_id=OLD.user_id AND hushh_id=OLD.hushh_id;
 archived:=(to_jsonb(OLD)-'backend_metadata')||jsonb_build_object('backend_metadata',OLD.backend_metadata-'detachedPlacements');
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(current_metadata->'detachedPlacements','[]'::jsonb)) item
    WHERE item-ARRAY['detachedAt','reason']=archived) THEN RETURN NEW; END IF;
 SELECT coalesce(jsonb_object_agg(key,value),'{}'::jsonb) INTO retained_metadata
 FROM jsonb_each(OLD.backend_metadata) WHERE key<>'url' AND key<>'detachedPlacements' AND key NOT LIKE 'puppy%';
 IF EXISTS(SELECT 1 FROM public.personal_agent_standby_placements standby WHERE standby.user_id=OLD.user_id AND standby.hushh_id=OLD.hushh_id
  AND standby.backend_metadata=retained_metadata AND standby.url IS NOT DISTINCT FROM OLD.backend_metadata->>'url'
  AND NOT EXISTS(SELECT 1 FROM unnest(ARRAY['deployment_target','backend','external_agent_id','region','model_credential_mode',
   'user_cloud_project','user_cloud_region','user_cloud_bootstrap_sa','user_cloud_authorized_at','user_cloud_tenant_id',
   'user_cloud_subscription_id','user_cloud_resource_group','pod_pubkey','pod_key_id','pod_key_wrapping_alg',
   'pod_signing_pubkey','pod_signing_key_id','runtime_version','prompt_version']) key
   WHERE to_jsonb(standby)->key IS DISTINCT FROM to_jsonb(OLD)->key)) THEN RETURN NEW; END IF;
 RAISE EXCEPTION 'notification checkpoint prior host custody not retained' USING ERRCODE='42501';
END;
$function$
$object$;
 ELSIF encode(sha256(convert_to(actual,'UTF8')),'hex') NOT IN ('ad51a1c155c259e73e7182e55a13ff7276598e9be40640d130d2cdfbcda48a17') THEN
  RAISE EXCEPTION 'Unqualified schema drift: guard_personal_agent_notification_retention';
 END IF;
END
$object_guard$;

REVOKE ALL ON FUNCTION public."guard_personal_agent_notification_retention"() FROM PUBLIC;

DO $pod_414$
BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN GRANT EXECUTE ON FUNCTION public."guard_personal_agent_notification_retention"() TO service_role; END IF;
END
$pod_414$;

DO $object_guard$
DECLARE actual text;
BEGIN
 SELECT definition INTO actual FROM (SELECT pg_get_functiondef(p.oid) definition FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='guard_personal_agent_notification_standby_retention' AND pg_get_function_identity_arguments(p.oid)='') observed;
 IF actual IS NULL THEN
  EXECUTE $object$CREATE OR REPLACE FUNCTION public.guard_personal_agent_notification_standby_retention()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE primary_record jsonb; custody jsonb:=public.notification_placement_custody(to_jsonb(OLD));
BEGIN
 IF OLD.backend_metadata->'notificationCheckpoint' IS NULL THEN RETURN NEW; END IF;
 SELECT to_jsonb(r) INTO primary_record FROM public.personal_agent_registry r WHERE user_id=OLD.user_id AND hushh_id=OLD.hushh_id;
 IF EXISTS(SELECT 1 FROM public.personal_agent_standby_placements standby WHERE standby.user_id=OLD.user_id AND standby.hushh_id=OLD.hushh_id
   AND public.notification_placement_custody(to_jsonb(standby))=custody) THEN RETURN NEW; END IF;
 IF OLD.backend_metadata->'notificationCheckpoint'->>'phase' IS DISTINCT FROM 'observed' THEN
  RAISE EXCEPTION 'notification checkpoint standby transfer requires completed operation' USING ERRCODE='42501'; END IF;
 IF public.notification_placement_custody(primary_record)=custody
 OR EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(primary_record->'backend_metadata'->'detachedPlacements','[]'::jsonb)) item
    WHERE public.notification_placement_custody(item)=custody) THEN RETURN NEW; END IF;
 RAISE EXCEPTION 'notification checkpoint standby custody not retained' USING ERRCODE='42501';
END;
$function$
$object$;
 ELSIF encode(sha256(convert_to(actual,'UTF8')),'hex') NOT IN ('2b805576d4ceb875855f44a412337cdef83d9b0ba2f439c5e12a2e3c83f539c5') THEN
  RAISE EXCEPTION 'Unqualified schema drift: guard_personal_agent_notification_standby_retention';
 END IF;
END
$object_guard$;

REVOKE ALL ON FUNCTION public."guard_personal_agent_notification_standby_retention"() FROM PUBLIC;

DO $pod_414$
BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN GRANT EXECUTE ON FUNCTION public."guard_personal_agent_notification_standby_retention"() TO service_role; END IF;
END
$pod_414$;

DO $object_guard$
DECLARE actual text;
BEGIN
 SELECT definition INTO actual FROM (SELECT pg_get_functiondef(p.oid) definition FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='guard_personal_agent_provision_registry' AND pg_get_function_identity_arguments(p.oid)='') observed;
 IF actual IS NULL THEN
  EXECUTE $object$CREATE OR REPLACE FUNCTION public.guard_personal_agent_provision_registry()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
BEGIN
  -- The later erasure trigger owns all mutations after reservation.
  IF OLD.backend_metadata ? 'erasure' THEN
    IF TG_OP='DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;
  IF OLD.backend_metadata ? 'provisionAttempt'
     AND OLD.backend_metadata->'provisionAttempt'->>'phase' IS DISTINCT FROM 'provisioned' THEN
    IF TG_OP = 'DELETE' THEN
      RAISE EXCEPTION 'personal agent provision retained' USING ERRCODE='42501';
    END IF;
    -- Existing erasure admission may capture the attempt, never discard it.
    IF NOT (OLD.backend_metadata ? 'erasure')
       AND NEW.status = 'suspended'
       AND NEW.backend_metadata->'erasure'->'registrySnapshot' = to_jsonb(OLD)
       AND NEW.backend_metadata - 'erasure' = OLD.backend_metadata
       AND to_jsonb(NEW) - ARRAY['status','updated_at','backend_metadata'] =
           to_jsonb(OLD) - ARRAY['status','updated_at','backend_metadata'] THEN
      RETURN NEW;
    END IF;
    -- The publication function sets this transaction-local coordination token.
    -- It is an accidental-writer guard, not authentication against database admins.
    IF current_setting('hussh.provision_attempt', true) =
       OLD.backend_metadata->'provisionAttempt'->>'attemptId'
       AND NEW.backend_metadata->'provisionAttempt'->>'attemptId' =
           OLD.backend_metadata->'provisionAttempt'->>'attemptId' THEN
      RETURN NEW;
    END IF;
    -- Pod heartbeat observations do not own lifecycle or resource coordinates.
    -- Nor does the signed-request key-pull throttle stamp (pod_request_verifier):
    -- on a pod with no Google token it is the only way its key is ever pulled.
    IF to_jsonb(NEW) - ARRAY['last_heartbeat_at','health_state','liveness_failures','backend_metadata'] =
       to_jsonb(OLD) - ARRAY['last_heartbeat_at','health_state','liveness_failures','backend_metadata']
       AND NEW.backend_metadata - ARRAY['observed','signingKeyPull']
           = OLD.backend_metadata - ARRAY['observed','signingKeyPull']
       AND (NOT (NEW.backend_metadata ? 'signingKeyPull')
            OR jsonb_typeof(NEW.backend_metadata->'signingKeyPull') = 'number') THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'personal agent provision retained' USING ERRCODE='42501';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$function$
$object$;
 ELSIF encode(sha256(convert_to(actual,'UTF8')),'hex') NOT IN ('87badebd6f5bb2bd5f8ab90169ff00ba016d433356c8a7f8d2fd829117fbfd6a') THEN
  RAISE EXCEPTION 'Unqualified schema drift: guard_personal_agent_provision_registry';
 END IF;
END
$object_guard$;

REVOKE ALL ON FUNCTION public."guard_personal_agent_provision_registry"() FROM PUBLIC;

DO $pod_414$
BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN GRANT EXECUTE ON FUNCTION public."guard_personal_agent_provision_registry"() TO service_role; END IF;
END
$pod_414$;

DO $object_guard$
DECLARE actual text;
BEGIN
 SELECT definition INTO actual FROM (SELECT pg_get_functiondef(p.oid) definition FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='guard_personal_agent_renewal' AND pg_get_function_identity_arguments(p.oid)='') observed;
 IF actual IS NULL THEN
  EXECUTE $object$CREATE OR REPLACE FUNCTION public.guard_personal_agent_renewal()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
  prior public.consent_audit%ROWTYPE;
  details jsonb;
  automatic boolean;
BEGIN
  IF NEW.agent_id <> 'personal_agent' OR
     NEW.action NOT IN ('CONSENT_GRANTED', 'REVOKED', 'CONSENT_DENIED') THEN
    RETURN NEW;
  END IF;

  -- Account identity triggers run first (their names precede zz_). The
  -- per-grant lock follows those existing shared owner lifecycle barriers.
  PERFORM pg_advisory_xact_lock(hashtextextended(
    jsonb_build_array(NEW.user_id, NEW.agent_id, NEW.scope)::text, 315));
  SELECT * INTO prior FROM public.consent_audit
    WHERE user_id = NEW.user_id AND agent_id = NEW.agent_id AND scope = NEW.scope
      AND action IN ('CONSENT_GRANTED', 'REVOKED', 'CONSENT_DENIED')
    ORDER BY issued_at DESC, id DESC LIMIT 1;
  details := coalesce(NEW.metadata::jsonb, '{}'::jsonb);
  automatic := details->>'automatic_renewal' = 'true'
    OR details->>'grant_kind' LIKE 'personal_agent_%';

  -- A stale expiry worker must not revoke a replacement or overwrite an
  -- owner's explicit revocation with an automatically renewable expiry event.
  IF NEW.action = 'REVOKED' AND details->>'reason' = 'expired'
     AND details->>'source' = 'consent_revocation_worker' THEN
    IF prior.action IS DISTINCT FROM 'CONSENT_GRANTED'
       OR prior.token_id IS DISTINCT FROM NEW.token_id
       OR prior.expires_at IS NULL
       OR prior.expires_at > floor(extract(epoch FROM clock_timestamp()) * 1000) THEN
      RAISE EXCEPTION 'personal agent expiry superseded' USING ERRCODE = '40001';
    END IF;
  END IF;

  IF NEW.action = 'CONSENT_GRANTED' AND automatic AND
     prior.action IN ('REVOKED', 'CONSENT_DENIED') AND NOT (
       prior.action = 'REVOKED'
       AND coalesce(prior.metadata::jsonb->>'reason', '') = 'expired'
       AND coalesce(prior.metadata::jsonb->>'source', '') = 'consent_revocation_worker'
       AND prior.expires_at IS NOT NULL
       AND prior.expires_at <= floor(extract(epoch FROM clock_timestamp()) * 1000)
     ) THEN
    RAISE EXCEPTION 'personal agent consent requires owner reapproval' USING ERRCODE = '42501';
  END IF;

  -- Validators order by issued_at. Preserve commit order even when requests
  -- were timestamped before waiting, or arrived in the same millisecond.
  IF prior.issued_at IS NOT NULL THEN
    NEW.issued_at := greatest(NEW.issued_at, prior.issued_at + 1);
  END IF;
  RETURN NEW;
END;
$function$
$object$;
 ELSIF encode(sha256(convert_to(actual,'UTF8')),'hex') NOT IN ('4cb0a8824df461b46287a2f15ae28fa1cdcd2e40d3d673508a268c5222e68d44') THEN
  RAISE EXCEPTION 'Unqualified schema drift: guard_personal_agent_renewal';
 END IF;
END
$object_guard$;

REVOKE ALL ON FUNCTION public."guard_personal_agent_renewal"() FROM PUBLIC;

DO $pod_414$
BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN GRANT EXECUTE ON FUNCTION public."guard_personal_agent_renewal"() TO service_role; END IF;
END
$pod_414$;

DO $object_guard$
DECLARE actual text;
BEGIN
 SELECT definition INTO actual FROM (SELECT pg_get_functiondef(p.oid) definition FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='guard_personal_agent_standby_placement' AND pg_get_function_identity_arguments(p.oid)='') observed;
 IF actual IS NULL THEN
  EXECUTE $object$CREATE OR REPLACE FUNCTION public.guard_personal_agent_standby_placement()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE primary_row public.personal_agent_registry%ROWTYPE;
BEGIN
  SELECT * INTO primary_row FROM public.personal_agent_registry WHERE user_id = NEW.user_id;
  IF NOT FOUND OR primary_row.hushh_id IS DISTINCT FROM NEW.hushh_id THEN
    RAISE EXCEPTION 'standby placement must belong to its registry row' USING ERRCODE='42501';
  END IF;
  IF NEW.pod_signing_key_id IS NOT DISTINCT FROM primary_row.pod_signing_key_id
     OR NEW.pod_key_id IS NOT DISTINCT FROM primary_row.pod_key_id
     OR NEW.external_agent_id IS NOT DISTINCT FROM primary_row.external_agent_id THEN
    RAISE EXCEPTION 'standby placement must not share the primary''s keys or host' USING ERRCODE='42501';
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.synced_seq < OLD.synced_seq THEN
    RAISE EXCEPTION 'standby synced sequence never moves backwards' USING ERRCODE='42501';
  END IF;
  RETURN NEW;
END;
$function$
$object$;
 ELSIF encode(sha256(convert_to(actual,'UTF8')),'hex') NOT IN ('dd6cb41132a3750363b515ed4e3cbd0b913273d74ac5d9224c1d573dc34ade77') THEN
  RAISE EXCEPTION 'Unqualified schema drift: guard_personal_agent_standby_placement';
 END IF;
END
$object_guard$;

REVOKE ALL ON FUNCTION public."guard_personal_agent_standby_placement"() FROM PUBLIC;

DO $pod_414$
BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN GRANT EXECUTE ON FUNCTION public."guard_personal_agent_standby_placement"() TO service_role; END IF;
END
$pod_414$;

DO $object_guard$
DECLARE actual text;
BEGIN
 SELECT definition INTO actual FROM (SELECT pg_get_functiondef(p.oid) definition FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='guard_project_grant_registry_admission' AND pg_get_function_identity_arguments(p.oid)='') observed;
 IF actual IS NULL THEN
  EXECUTE $object$CREATE OR REPLACE FUNCTION public.guard_project_grant_registry_admission()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
BEGIN
 IF TG_OP='INSERT' THEN
  -- ON CONFLICT acquires its existing row only after BEFORE INSERT. Match
  -- lifecycle admission's owner -> row -> project order before that happens.
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW.user_id,171));
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW.user_id,198));
  PERFORM 1 FROM public.personal_agent_registry WHERE user_id=NEW.user_id FOR UPDATE;
  PERFORM public.assert_project_grant_admission(NEW.user_cloud_project);
 ELSIF NEW.user_cloud_project IS DISTINCT FROM OLD.user_cloud_project
 OR NEW.user_cloud_bootstrap_sa IS DISTINCT FROM OLD.user_cloud_bootstrap_sa
 OR NEW.backend_metadata->'upgradeLease' IS DISTINCT FROM OLD.backend_metadata->'upgradeLease' AND NEW.backend_metadata->>'upgradeLease' IS NOT NULL
 OR NEW.backend_metadata->'provisionAttempt'->>'attemptId' IS DISTINCT FROM OLD.backend_metadata->'provisionAttempt'->>'attemptId'
 THEN PERFORM public.assert_project_grant_admission(NEW.user_cloud_project);
 END IF;
 RETURN NEW;
END;
$function$
$object$;
 ELSIF encode(sha256(convert_to(actual,'UTF8')),'hex') NOT IN ('1912f59585796ac340a29f56fa7875726e742531b716fa9b98612a555cc3a6ca') THEN
  RAISE EXCEPTION 'Unqualified schema drift: guard_project_grant_registry_admission';
 END IF;
END
$object_guard$;

REVOKE ALL ON FUNCTION public."guard_project_grant_registry_admission"() FROM PUBLIC;

DO $pod_414$
BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN GRANT EXECUTE ON FUNCTION public."guard_project_grant_registry_admission"() TO service_role; END IF;
END
$pod_414$;

DO $object_guard$
DECLARE actual text;
BEGIN
 SELECT definition INTO actual FROM (SELECT pg_get_functiondef(p.oid) definition FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='guard_project_grant_setup_admission' AND pg_get_function_identity_arguments(p.oid)='') observed;
 IF actual IS NULL THEN
  EXECUTE $object$CREATE OR REPLACE FUNCTION public.guard_project_grant_setup_admission()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
BEGIN
 IF TG_OP='INSERT' THEN
  PERFORM public.assert_project_grant_admission(NEW.project_id);
 ELSIF NEW.project_id IS DISTINCT FROM OLD.project_id OR NEW.job_id IS DISTINCT FROM OLD.job_id
 OR NEW.status='running' AND OLD.status IS DISTINCT FROM 'running' THEN
  PERFORM public.assert_project_grant_admission(NEW.project_id);
 END IF;
 RETURN NEW;
END;
$function$
$object$;
 ELSIF encode(sha256(convert_to(actual,'UTF8')),'hex') NOT IN ('08b0ee065891a7079b8ea497920ef3c77cfa9c755e87fed702e13163439bd10e') THEN
  RAISE EXCEPTION 'Unqualified schema drift: guard_project_grant_setup_admission';
 END IF;
END
$object_guard$;

REVOKE ALL ON FUNCTION public."guard_project_grant_setup_admission"() FROM PUBLIC;

DO $pod_414$
BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN GRANT EXECUTE ON FUNCTION public."guard_project_grant_setup_admission"() TO service_role; END IF;
END
$pod_414$;

DO $object_guard$
DECLARE actual text;
BEGIN
 SELECT definition INTO actual FROM (SELECT pg_get_functiondef(p.oid) definition FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='insert_personal_agent_renewal' AND pg_get_function_identity_arguments(p.oid)='event jsonb') observed;
 IF actual IS NULL THEN
  EXECUTE $object$CREATE OR REPLACE FUNCTION public.insert_personal_agent_renewal(event jsonb)
 RETURNS SETOF consent_audit
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
  incoming public.consent_audit%ROWTYPE;
BEGIN
  incoming := jsonb_populate_record(NULL::public.consent_audit,
    event || jsonb_build_object('metadata', (event->>'metadata')::jsonb));
  IF incoming.agent_id IS DISTINCT FROM 'personal_agent'
     OR incoming.action IS DISTINCT FROM 'CONSENT_GRANTED'
     OR incoming.metadata::jsonb->>'automatic_renewal' IS DISTINCT FROM 'true' THEN
    RAISE EXCEPTION 'invalid personal agent renewal' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgrelid = 'public.consent_audit'::regclass
      AND tgname = 'zz_personal_agent_renewal_authority'
      AND tgenabled IN ('O', 'A')
      AND tgtype = 7 AND tgnargs = 0 AND tgqual IS NULL
      AND tgfoid = 'public.guard_personal_agent_renewal()'::regprocedure
  ) THEN
    RAISE EXCEPTION 'personal agent renewal authority unavailable' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY INSERT INTO public.consent_audit (
    token_id, user_id, agent_id, scope, action, issued_at, expires_at,
    request_id, scope_description, poll_timeout_at, metadata
  ) VALUES (
    incoming.token_id, incoming.user_id, incoming.agent_id, incoming.scope,
    incoming.action, incoming.issued_at, incoming.expires_at, incoming.request_id,
    incoming.scope_description, incoming.poll_timeout_at, incoming.metadata
  ) RETURNING *;
END;
$function$
$object$;
 ELSIF encode(sha256(convert_to(actual,'UTF8')),'hex') NOT IN ('8ef79b54f25f4ec91dfa552d96771d9b8af02ee85d08b4a95a954ca016de6cfc') THEN
  RAISE EXCEPTION 'Unqualified schema drift: insert_personal_agent_renewal';
 END IF;
END
$object_guard$;

REVOKE ALL ON FUNCTION public."insert_personal_agent_renewal"(jsonb) FROM PUBLIC;

DO $pod_414$
BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN GRANT EXECUTE ON FUNCTION public."insert_personal_agent_renewal"(jsonb) TO service_role; END IF;
END
$pod_414$;

DO $object_guard$
DECLARE actual text;
BEGIN
 SELECT definition INTO actual FROM (SELECT pg_get_functiondef(p.oid) definition FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='notification_checkpoint_admission_ready' AND pg_get_function_identity_arguments(p.oid)='') observed;
 IF actual IS NULL THEN
  EXECUTE $object$CREATE OR REPLACE FUNCTION public.notification_checkpoint_admission_ready()
 RETURNS boolean
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
 SELECT to_regprocedure('public.publish_personal_agent_notification_checkpoint(text,text,text,text,bigint,jsonb)') IS NOT NULL
 AND EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.personal_agent_registry'::regclass
  AND tgname='zy_personal_agent_provision_registry' AND tgenabled IN ('O','A') AND tgtype=27 AND tgnargs=0 AND tgqual IS NULL
  AND tgfoid='public.guard_personal_agent_provision_registry()'::regprocedure)
 AND EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.personal_agent_registry'::regclass
  AND tgname='zz_personal_agent_erasure_registry' AND tgenabled IN ('O','A') AND tgtype=27 AND tgnargs=0 AND tgqual IS NULL
  AND tgfoid='public.guard_personal_agent_erasure_registry()'::regprocedure)
 AND EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.personal_agent_registry'::regclass
  AND tgname='zx_personal_agent_notification_registry' AND tgenabled IN ('O','A') AND tgtype=19 AND tgnargs=0 AND tgqual IS NULL
  AND tgfoid='public.guard_personal_agent_notification_registry()'::regprocedure)
 AND EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.personal_agent_registry'::regclass
  AND tgname='zz_personal_agent_notification_retention' AND tgenabled IN ('O','A') AND tgtype=25 AND tgnargs=0 AND tgqual IS NULL
  AND tgdeferrable AND tginitdeferred AND tgfoid='public.guard_personal_agent_notification_retention()'::regprocedure)
 AND EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.personal_agent_standby_placements'::regclass
  AND tgname='zz_personal_agent_notification_standby_retention' AND tgenabled IN ('O','A') AND tgtype=25 AND tgnargs=0 AND tgqual IS NULL
  AND tgdeferrable AND tginitdeferred AND tgfoid='public.guard_personal_agent_notification_standby_retention()'::regprocedure)
 AND to_regprocedure('public.notification_placement_custody(jsonb)') IS NOT NULL
 AND to_regprocedure('public.notification_erasure_custody_archived(text,jsonb,jsonb)') IS NOT NULL
 AND to_regprocedure('public.valid_personal_agent_notification_checkpoint(jsonb,jsonb,jsonb)') IS NOT NULL
 AND to_regprocedure('public.notification_checkpoint_inventory(jsonb,jsonb)') IS NOT NULL
 AND position('notification_checkpoint_inventory' IN pg_get_functiondef('public.effective_erasure_substrate_inventory(jsonb)'::regprocedure))>0
 AND position('lateNotificationObservation' IN pg_get_functiondef('public.valid_erasure_substrate_inventory(jsonb,jsonb)'::regprocedure))>0
 AND position('valid_erasure_notification_observation' IN pg_get_functiondef('public.guard_personal_agent_erasure_registry()'::regprocedure))>0
 AND to_regprocedure('public.erasure_mail_resource_state(jsonb,text,text)') IS NOT NULL
 AND to_regprocedure('public.erasure_mail_resources_deleted(jsonb)') IS NOT NULL
 AND position('erasure_mail_resource_state' IN pg_get_functiondef('public.valid_erasure_mail_receipt(jsonb,text,text,jsonb)'::regprocedure))>0
 AND position('resources' IN pg_get_functiondef('public.valid_erasure_mail_append(jsonb,jsonb)'::regprocedure))>0
 AND position('erasure_mail_resources_deleted' IN pg_get_functiondef('public.valid_erasure_kms_receipt(jsonb,text,jsonb)'::regprocedure))>0
 AND position('erasure_mail_resources_deleted' IN pg_get_functiondef('public.verify_erasure_kms_preflight(text,text,jsonb)'::regprocedure))>0
 AND position('erasure_mail_resource_state' IN pg_get_functiondef('public.erasure_planned_resources_covered(jsonb)'::regprocedure))>0
 AND position('resourcesByKind' IN pg_get_functiondef('public.personal_agent_erasure_archive(jsonb,jsonb)'::regprocedure))>0;
$function$
$object$;
 ELSIF encode(sha256(convert_to(actual,'UTF8')),'hex') NOT IN ('6cf73f7af9d0dd1e479d314e240afa7ac446128f769fa381c87e6f972dfa4267') THEN
  RAISE EXCEPTION 'Unqualified schema drift: notification_checkpoint_admission_ready';
 END IF;
END
$object_guard$;

REVOKE ALL ON FUNCTION public."notification_checkpoint_admission_ready"() FROM PUBLIC;

DO $pod_414$
BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN GRANT EXECUTE ON FUNCTION public."notification_checkpoint_admission_ready"() TO service_role; END IF;
END
$pod_414$;

DO $object_guard$
DECLARE actual text;
BEGIN
 SELECT definition INTO actual FROM (SELECT pg_get_functiondef(p.oid) definition FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='notification_checkpoint_inventory' AND pg_get_function_identity_arguments(p.oid)='inventory jsonb, checkpoint jsonb') observed;
 IF actual IS NULL THEN
  EXECUTE $object$CREATE OR REPLACE FUNCTION public.notification_checkpoint_inventory(inventory jsonb, checkpoint jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 IMMUTABLE
 SET search_path TO 'public'
AS $function$
DECLARE item jsonb; result jsonb; values_array jsonb; resources jsonb;
BEGIN
 IF inventory IS NULL OR inventory='null'::jsonb THEN
  inventory:=jsonb_build_object('version','byoc.substrate.receipt.v1','tenantRef',checkpoint->>'project'||'/'||(checkpoint->>'region'),
   'resourceIds','[]'::jsonb,'plannedResources','[]'::jsonb,'resourceObservations','[]'::jsonb,'bindingObservations','[]'::jsonb,'applied',false);
 END IF;
 resources:=coalesce(inventory->'plannedResources','[]'::jsonb);
 FOR item IN SELECT value FROM jsonb_array_elements(checkpoint->'plan'->'plannedResources') LOOP
  IF NOT resources @> jsonb_build_array(item) THEN resources:=resources||jsonb_build_array(item); END IF;
 END LOOP;
 inventory:=jsonb_set(inventory,'{plannedResources}',resources,true);
 SELECT jsonb_agg(id ORDER BY id) INTO values_array FROM (
  SELECT DISTINCT value->>'id' id FROM jsonb_array_elements(resources)
 ) ids;
 inventory:=jsonb_set(inventory,'{resourceIds}',coalesce(values_array,'[]'::jsonb),true);
 FOR result IN SELECT value FROM jsonb_array_elements(checkpoint->'completed') LOOP
  IF result ? 'resourceObservation' THEN
   item:=result->'resourceObservation'; values_array:=coalesce(inventory->'resourceObservations','[]'::jsonb);
   IF EXISTS(SELECT 1 FROM jsonb_array_elements(values_array) x WHERE x->>'type'=item->>'type' AND x->>'id'=item->>'id' AND x<>item) THEN RETURN NULL; END IF;
   IF NOT values_array @> jsonb_build_array(item) THEN values_array:=values_array||jsonb_build_array(item); END IF;
   inventory:=jsonb_set(inventory,'{resourceObservations}',values_array,true);
  END IF;
  FOR item IN SELECT value FROM jsonb_array_elements(coalesce(result->'bindingObservations','[]'::jsonb)) LOOP
   values_array:=coalesce(inventory->'bindingObservations','[]'::jsonb);
   IF NOT values_array @> jsonb_build_array(item) THEN values_array:=values_array||jsonb_build_array(item); END IF;
   inventory:=jsonb_set(inventory,'{bindingObservations}',values_array,true);
  END LOOP;
  -- Preserve operator grant provenance across retries and later operations.
  FOR item IN SELECT value FROM jsonb_array_elements(coalesce(result->'operatorBindingObservations','[]'::jsonb)) LOOP
   values_array:=coalesce(inventory->'operatorBindingObservations','[]'::jsonb);
   IF NOT values_array @> jsonb_build_array(item) THEN values_array:=values_array||jsonb_build_array(item); END IF;
   IF jsonb_array_length(values_array)>128 THEN RETURN NULL; END IF;
   inventory:=jsonb_set(inventory,'{operatorBindingObservations}',values_array,true);
  END LOOP;
 END LOOP;
 RETURN inventory;
END;
$function$
$object$;
 ELSIF encode(sha256(convert_to(actual,'UTF8')),'hex') NOT IN ('15b88701e2093bbad524cc3244f4f4714c7ba06ce7fdf42e2bd2e7e2645cba63') THEN
  RAISE EXCEPTION 'Unqualified schema drift: notification_checkpoint_inventory';
 END IF;
END
$object_guard$;

REVOKE ALL ON FUNCTION public."notification_checkpoint_inventory"(jsonb, jsonb) FROM PUBLIC;

DO $pod_414$
BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN GRANT EXECUTE ON FUNCTION public."notification_checkpoint_inventory"(jsonb, jsonb) TO service_role; END IF;
END
$pod_414$;

DO $object_guard$
DECLARE actual text;
BEGIN
 SELECT definition INTO actual FROM (SELECT pg_get_functiondef(p.oid) definition FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='notification_erasure_custody_archived' AND pg_get_function_identity_arguments(p.oid)='owner_id text, r jsonb, placement jsonb') observed;
 IF actual IS NULL THEN
  EXECUTE $object$CREATE OR REPLACE FUNCTION public.notification_erasure_custody_archived(owner_id text, r jsonb, placement jsonb)
 RETURNS boolean
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
 SELECT public.personal_agent_erasure_archived(owner_id,r) IS TRUE
 AND placement->>'user_id'=owner_id AND placement->>'hushh_id'=r->>'hushhId'
 AND placement->>'user_cloud_project'=r->'registrySnapshot'->>'user_cloud_project'
 AND placement->>'user_cloud_region'=r->'registrySnapshot'->>'user_cloud_region'
 AND placement->'backend_metadata'->>'serviceUid'=r->'registrySnapshot'->'backend_metadata'->>'serviceUid'
 AND placement->'backend_metadata'->'notificationCheckpoint'->>'phase'='observed'
 AND EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(r->'registrySnapshot'->'backend_metadata'->'detachedPlacements','[]'::jsonb)) item WHERE item=placement)
 AND jsonb_typeof(placement->'backend_metadata'->'notificationCheckpoint'->'plan'->'plannedResources')='array'
 AND r->'substrateInventory'->'plannedResources' @> (placement->'backend_metadata'->'notificationCheckpoint'->'plan'->'plannedResources')
 AND jsonb_typeof(placement->'backend_metadata'->'substrateReceipt'->'plannedResources')='array'
 AND r->'substrateInventory'->'plannedResources' @> (placement->'backend_metadata'->'substrateReceipt'->'plannedResources')
 AND r->'substrateInventory'->'resourceObservations' @> coalesce(placement->'backend_metadata'->'substrateReceipt'->'resourceObservations','[]'::jsonb)
 AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(placement->'backend_metadata'->'notificationCheckpoint'->'completed','[]'::jsonb)) result
  WHERE result ? 'resourceObservation' AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(r->'substrateInventory'->'resourceObservations') observation WHERE observation=result->'resourceObservation'))
 AND coalesce(r->'substrateInventory'->'operatorBindingObservations','[]'::jsonb) @>
  coalesce(placement->'backend_metadata'->'substrateReceipt'->'operatorBindingObservations','[]'::jsonb)
 AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(placement->'backend_metadata'->'notificationCheckpoint'->'completed','[]'::jsonb)) result
  WHERE NOT coalesce(r->'substrateInventory'->'operatorBindingObservations','[]'::jsonb) @>
   coalesce(result->'operatorBindingObservations','[]'::jsonb))
 AND public.erasure_planned_resources_covered(r) IS TRUE
 AND public.erasure_mail_resources_deleted(r) IS TRUE;
$function$
$object$;
 ELSIF encode(sha256(convert_to(actual,'UTF8')),'hex') NOT IN ('6d7ff771919e5c98172482805906f1dd69209542e7614987257f61012fadc3b3') THEN
  RAISE EXCEPTION 'Unqualified schema drift: notification_erasure_custody_archived';
 END IF;
END
$object_guard$;

REVOKE ALL ON FUNCTION public."notification_erasure_custody_archived"(text, jsonb, jsonb) FROM PUBLIC;

DO $pod_414$
BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN GRANT EXECUTE ON FUNCTION public."notification_erasure_custody_archived"(text, jsonb, jsonb) TO service_role; END IF;
END
$pod_414$;

DO $object_guard$
DECLARE actual text;
BEGIN
 SELECT definition INTO actual FROM (SELECT pg_get_functiondef(p.oid) definition FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='notification_initial_host_binding' AND pg_get_function_identity_arguments(p.oid)='previous jsonb, candidate jsonb') observed;
 IF actual IS NULL THEN
  EXECUTE $object$CREATE OR REPLACE FUNCTION public.notification_initial_host_binding(previous jsonb, candidate jsonb)
 RETURNS boolean
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public'
AS $function$
 SELECT coalesce(previous->>'status'='provisioning' AND previous->>'external_agent_id' IS NULL
 AND previous->'backend_metadata'->>'serviceUid' IS NULL
 AND previous->'backend_metadata'->'provisionAttempt'->>'phase'='host_requested'
 AND candidate->'backend_metadata'->'provisionAttempt'->>'phase'='host_acknowledged'
 AND candidate->>'user_id'=previous->>'user_id' AND candidate->>'hushh_id'=previous->>'hushh_id'
 AND candidate->'backend_metadata'->'provisionAttempt'->>'attemptId'=previous->'backend_metadata'->'provisionAttempt'->>'attemptId'
 AND candidate->'backend_metadata'->'notificationCheckpoint'=previous->'backend_metadata'->'notificationCheckpoint'
 AND candidate->>'external_agent_id'=previous->'backend_metadata'->'provisionAttempt'->'evidence'->'host_requested'->'creationAcknowledgement'->>'service'
 AND candidate->'backend_metadata'->>'serviceUid'=previous->'backend_metadata'->'provisionAttempt'->'evidence'->'host_requested'->'creationAcknowledgement'->>'serviceUid'
 AND candidate->>'backend'=previous->'backend_metadata'->'provisionAttempt'->'evidence'->'host_requested'->'creationAcknowledgement'->>'backend'
 AND candidate->>'user_cloud_project'=previous->>'user_cloud_project' AND candidate->>'user_cloud_region'=previous->>'user_cloud_region'
 AND candidate->>'user_cloud_project'=previous->'backend_metadata'->'provisionAttempt'->'evidence'->'host_requested'->'creationAcknowledgement'->>'project'
 AND candidate->>'user_cloud_region'=previous->'backend_metadata'->'provisionAttempt'->'evidence'->'host_requested'->'creationAcknowledgement'->>'region'
 AND candidate->'backend_metadata'->'provisionAttempt'->'evidence'->'host_requested'->'creationAcknowledgement'=previous->'backend_metadata'->'provisionAttempt'->'evidence'->'host_requested'->'creationAcknowledgement',false);
$function$
$object$;
 ELSIF encode(sha256(convert_to(actual,'UTF8')),'hex') NOT IN ('8fac2a2d31fd363ea69580202d1c43989b70d3dfec6366e913a8b17befcc8119') THEN
  RAISE EXCEPTION 'Unqualified schema drift: notification_initial_host_binding';
 END IF;
END
$object_guard$;

REVOKE ALL ON FUNCTION public."notification_initial_host_binding"(jsonb, jsonb) FROM PUBLIC;

DO $pod_414$
BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN GRANT EXECUTE ON FUNCTION public."notification_initial_host_binding"(jsonb, jsonb) TO service_role; END IF;
END
$pod_414$;

DO $object_guard$
DECLARE actual text;
BEGIN
 SELECT definition INTO actual FROM (SELECT pg_get_functiondef(p.oid) definition FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='notification_placement_custody' AND pg_get_function_identity_arguments(p.oid)='placement jsonb') observed;
 IF actual IS NULL THEN
  EXECUTE $object$CREATE OR REPLACE FUNCTION public.notification_placement_custody(placement jsonb)
 RETURNS jsonb
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public'
AS $function$
 SELECT jsonb_build_object('url',coalesce(placement->'url',placement->'backend_metadata'->'url'),
  'backend_metadata',(SELECT coalesce(jsonb_object_agg(key,value),'{}'::jsonb)
   FROM jsonb_each(coalesce(placement->'backend_metadata','{}'::jsonb))
   WHERE key<>'url' AND key<>'detachedPlacements' AND key NOT LIKE 'puppy%')) ||
  (SELECT jsonb_object_agg(key,placement->key) FROM unnest(ARRAY['user_id','hushh_id','deployment_target','backend',
   'external_agent_id','region','model_credential_mode','user_cloud_project','user_cloud_region',
   'user_cloud_bootstrap_sa','user_cloud_authorized_at','user_cloud_tenant_id','user_cloud_subscription_id',
   'user_cloud_resource_group','pod_pubkey','pod_key_id','pod_key_wrapping_alg','pod_signing_pubkey',
   'pod_signing_key_id','runtime_version','prompt_version','provisioned_at']) key);
$function$
$object$;
 ELSIF encode(sha256(convert_to(actual,'UTF8')),'hex') NOT IN ('5e32ff81f5ed6b153a3cc5d748a2695ea9ae706d1fd451fc07d2449355105abc') THEN
  RAISE EXCEPTION 'Unqualified schema drift: notification_placement_custody';
 END IF;
END
$object_guard$;

REVOKE ALL ON FUNCTION public."notification_placement_custody"(jsonb) FROM PUBLIC;

DO $pod_414$
BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN GRANT EXECUTE ON FUNCTION public."notification_placement_custody"(jsonb) TO service_role; END IF;
END
$pod_414$;

DO $object_guard$
DECLARE actual text;
BEGIN
 SELECT definition INTO actual FROM (SELECT pg_get_functiondef(p.oid) definition FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='operator_mail_grants_qualified' AND pg_get_function_identity_arguments(p.oid)='r jsonb, resource_id text') observed;
 IF actual IS NULL THEN
  EXECUTE $object$CREATE OR REPLACE FUNCTION public.operator_mail_grants_qualified(r jsonb, resource_id text)
 RETURNS boolean
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public'
AS $function$
 WITH terms AS (SELECT r->'registrySnapshot'->'backend_metadata'->'notificationCheckpoint' cp),
 grants AS (SELECT value observation FROM jsonb_array_elements(
  CASE WHEN jsonb_typeof(r->'substrateInventory'->'operatorBindingObservations')='array'
   THEN r->'substrateInventory'->'operatorBindingObservations' ELSE '[]'::jsonb END))
 SELECT coalesce(cp->>'ownerId'=r->>'ownerId' AND cp->>'hushhId'=r->>'hushhId'
  AND cp->>'project'=r->'registrySnapshot'->>'user_cloud_project'
  AND resource_id='projects/'||(cp->'plan'->>'oauthProject')||'/topics/one-mail-'||
    left(trim(both '-' from regexp_replace(lower(r->>'hushhId'),'[^a-z0-9-]+','-','g')),40)
  AND (SELECT count(*) FROM grants) BETWEEN 2 AND 128
  AND NOT EXISTS(SELECT 1 FROM grants WHERE observation->>'step' IS DISTINCT FROM 'iam_gmail_publisher_on_topic'
   OR observation->>'policyResource' IS DISTINCT FROM 'https://pubsub.googleapis.com/v1/'||resource_id||':getIamPolicy'
   OR (observation->>'disposition' IN ('added','already_present')) IS NOT TRUE
   OR ((observation->>'role',observation->>'member') IN (
      ('roles/pubsub.publisher','serviceAccount:gmail-api-push@system.gserviceaccount.com'),
      ('roles/pubsub.subscriber','serviceAccount:'||(cp->'plan'->>'bootstrapAccount')))) IS NOT TRUE)
  AND EXISTS(SELECT 1 FROM grants WHERE observation->>'disposition'='added'
    AND observation->>'role'='roles/pubsub.publisher')
  AND EXISTS(SELECT 1 FROM grants WHERE observation->>'disposition'='added'
    AND observation->>'role'='roles/pubsub.subscriber'),false) FROM terms;
$function$
$object$;
 ELSIF encode(sha256(convert_to(actual,'UTF8')),'hex') NOT IN ('84435af2b74e1c6e398fd4e66b431e4b1e09aa8ecdf91ce5658e7dab1773c6aa') THEN
  RAISE EXCEPTION 'Unqualified schema drift: operator_mail_grants_qualified';
 END IF;
END
$object_guard$;

REVOKE ALL ON FUNCTION public."operator_mail_grants_qualified"(jsonb, text) FROM PUBLIC;

DO $pod_414$
BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN GRANT EXECUTE ON FUNCTION public."operator_mail_grants_qualified"(jsonb, text) TO service_role; END IF;
END
$pod_414$;

DO $object_guard$
DECLARE actual text;
BEGIN
 SELECT definition INTO actual FROM (SELECT pg_get_functiondef(p.oid) definition FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='operator_notification_custody_ready' AND pg_get_function_identity_arguments(p.oid)='') observed;
 IF actual IS NULL THEN
  EXECUTE $object$CREATE OR REPLACE FUNCTION public.operator_notification_custody_ready()
 RETURNS boolean
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
 SELECT position('operatorBindingObservations' IN pg_get_functiondef('public.notification_checkpoint_inventory(jsonb,jsonb)'::regprocedure))>0
 AND position('oauth_mail_topic' IN pg_get_functiondef('public.valid_personal_agent_notification_checkpoint(jsonb,jsonb,jsonb)'::regprocedure))>0
 AND position('operator notification custody not retained' IN pg_get_functiondef('public.guard_personal_agent_notification_registry()'::regprocedure))>0
 AND position('operatorNotificationCustody' IN pg_get_functiondef('public.personal_agent_erasure_archive(jsonb,jsonb)'::regprocedure))>0;
$function$
$object$;
 ELSIF encode(sha256(convert_to(actual,'UTF8')),'hex') NOT IN ('2be30390171e4ae8d117a7eafaa08899bb285e134bbca734629ed728b5146610') THEN
  RAISE EXCEPTION 'Unqualified schema drift: operator_notification_custody_ready';
 END IF;
END
$object_guard$;

REVOKE ALL ON FUNCTION public."operator_notification_custody_ready"() FROM PUBLIC;

DO $pod_414$
BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN GRANT EXECUTE ON FUNCTION public."operator_notification_custody_ready"() TO service_role; END IF;
END
$pod_414$;

DO $object_guard$
DECLARE actual text;
BEGIN
 SELECT definition INTO actual FROM (SELECT pg_get_functiondef(p.oid) definition FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='operator_topic_custody_preserved' AND pg_get_function_identity_arguments(p.oid)='before_meta jsonb, after_meta jsonb') observed;
 IF actual IS NULL THEN
  EXECUTE $object$CREATE OR REPLACE FUNCTION public.operator_topic_custody_preserved(before_meta jsonb, after_meta jsonb)
 RETURNS boolean
 LANGUAGE plpgsql
 IMMUTABLE
 SET search_path TO 'public'
AS $function$
DECLARE field text; old_values jsonb; new_values jsonb; item jsonb;
BEGIN
 FOREACH field IN ARRAY ARRAY['operatorBindingObservations','plannedResources','resourceObservations'] LOOP
  old_values:=coalesce(before_meta->'substrateReceipt'->field,'[]'::jsonb);
  new_values:=coalesce(after_meta->'substrateReceipt'->field,'[]'::jsonb);
  IF jsonb_typeof(old_values) IS DISTINCT FROM 'array' OR jsonb_typeof(new_values) IS DISTINCT FROM 'array' THEN RETURN false; END IF;
  FOR item IN SELECT value FROM jsonb_array_elements(old_values) LOOP
   IF (field='operatorBindingObservations' OR (item->>'type'='pubsub_topic' AND item->>'id' LIKE 'projects/%'))
    AND NOT new_values @> jsonb_build_array(item) THEN RETURN false; END IF;
  END LOOP;
 END LOOP;
 RETURN true;
END;
$function$
$object$;
 ELSIF encode(sha256(convert_to(actual,'UTF8')),'hex') NOT IN ('39e333aa8b51b7d21a8fa2c07250c143227a36ceade244713fabd91be19cc2ac') THEN
  RAISE EXCEPTION 'Unqualified schema drift: operator_topic_custody_preserved';
 END IF;
END
$object_guard$;

REVOKE ALL ON FUNCTION public."operator_topic_custody_preserved"(jsonb, jsonb) FROM PUBLIC;

DO $pod_414$
BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN GRANT EXECUTE ON FUNCTION public."operator_topic_custody_preserved"(jsonb, jsonb) TO service_role; END IF;
END
$pod_414$;

DO $object_guard$
DECLARE actual text;
BEGIN
 SELECT definition INTO actual FROM (SELECT pg_get_functiondef(p.oid) definition FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='personal_agent_cloud_removal_covers' AND pg_get_function_identity_arguments(p.oid)='owner_id text, placement jsonb') observed;
 IF actual IS NULL THEN
  EXECUTE $object$CREATE OR REPLACE FUNCTION public.personal_agent_cloud_removal_covers(owner_id text, placement jsonb)
 RETURNS boolean
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
 SELECT public.personal_agent_cloud_removal_ready() IS TRUE AND placement->>'user_id'=owner_id
 AND EXISTS(SELECT 1 FROM public.personal_agent_cloud_removals c WHERE c.user_id=owner_id
  AND c.attempt_id=placement->>'cloudRemovalAttempt' AND c.completed_at IS NOT NULL
  AND c.archive->>'hushhId'=placement->>'hushh_id'
  AND c.snapshot_sha256=encode(sha256(convert_to((placement-ARRAY['detachedAt','cloudRemovalAttempt'])::text,'UTF8')),'hex'));
$function$
$object$;
 ELSIF encode(sha256(convert_to(actual,'UTF8')),'hex') NOT IN ('cd62420b3b8b366497951b58ebc4b5322c525d1fee33b607a0338a78af1a44e1') THEN
  RAISE EXCEPTION 'Unqualified schema drift: personal_agent_cloud_removal_covers';
 END IF;
END
$object_guard$;

REVOKE ALL ON FUNCTION public."personal_agent_cloud_removal_covers"(text, jsonb) FROM PUBLIC;

DO $pod_414$
BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN GRANT EXECUTE ON FUNCTION public."personal_agent_cloud_removal_covers"(text, jsonb) TO service_role; END IF;
END
$pod_414$;

DO $object_guard$
DECLARE actual text;
BEGIN
 SELECT definition INTO actual FROM (SELECT pg_get_functiondef(p.oid) definition FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='personal_agent_cloud_removal_execute_ready' AND pg_get_function_identity_arguments(p.oid)='owner_id text, attempt text') observed;
 IF actual IS NULL THEN
  EXECUTE $object$CREATE OR REPLACE FUNCTION public.personal_agent_cloud_removal_execute_ready(owner_id text, attempt text)
 RETURNS boolean
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
 SELECT public.personal_agent_cloud_removal_ready() IS TRUE AND EXISTS(
  SELECT 1 FROM public.personal_agent_cloud_removals c JOIN public.personal_agent_registry p ON p.user_id=c.user_id
  WHERE c.user_id=owner_id AND c.attempt_id=attempt AND c.completed_at IS NULL
  AND p.status='suspended' AND p.backend_metadata->'erasure'->>'attemptId'=attempt
  AND p.backend_metadata->'erasure'->>'ownerId'=owner_id AND p.placement_epoch=c.placement_epoch
  AND c.snapshot_sha256=encode(sha256(convert_to((p.backend_metadata->'erasure'->'registrySnapshot')::text,'UTF8')),'hex')
  AND c.approved_digest=encode(sha256(convert_to(public.personal_agent_cloud_removal_review(p.backend_metadata->'erasure')::text,'UTF8')),'hex')
  AND c.approved_at>clock_timestamp()-interval '10 minutes');
$function$
$object$;
 ELSIF encode(sha256(convert_to(actual,'UTF8')),'hex') NOT IN ('f9bb125899275e239c94578f20819d1ff0ae65802097611938d6f6d7be8cae81','cfc21908b66ec4dd828dc2727f71e0804944146be5491210ddd09896476649b6') THEN
  RAISE EXCEPTION 'Unqualified schema drift: personal_agent_cloud_removal_execute_ready';
 END IF;
END
$object_guard$;

REVOKE ALL ON FUNCTION public."personal_agent_cloud_removal_execute_ready"(text, text) FROM PUBLIC;

DO $pod_414$
BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN GRANT EXECUTE ON FUNCTION public."personal_agent_cloud_removal_execute_ready"(text, text) TO service_role; END IF;
END
$pod_414$;

DO $object_guard$
DECLARE actual text;
BEGIN
 SELECT definition INTO actual FROM (SELECT pg_get_functiondef(p.oid) definition FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='personal_agent_cloud_removal_identity' AND pg_get_function_identity_arguments(p.oid)='agent jsonb, removed_at timestamp with time zone, attempt text') observed;
 IF actual IS NULL THEN
  EXECUTE $object$CREATE OR REPLACE FUNCTION public.personal_agent_cloud_removal_identity(agent jsonb, removed_at timestamp with time zone, attempt text)
 RETURNS jsonb
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public'
AS $function$
 SELECT jsonb_build_object('user_id',agent->'user_id','hushh_id',agent->'hushh_id',
  'phone_e164_hash',agent->'phone_e164_hash','space_id',agent->'space_id',
  'billing_space_id',agent->'billing_space_id','a2a_route',agent->'a2a_route',
  'identity_mode',agent->'identity_mode','placement_epoch',coalesce((agent->>'placement_epoch')::bigint,0)+1,
  'status','unprovisioned','health_state','unknown','liveness_mode',agent->'liveness_mode',
  'liveness_failures',0,'created_at',agent->'created_at','updated_at',to_jsonb(removed_at),
  'backend_metadata',jsonb_build_object('detachedPlacements',
   coalesce(agent->'backend_metadata'->'detachedPlacements','[]'::jsonb)
   || jsonb_build_array((agent->'backend_metadata'->'erasure'->'registrySnapshot')
    || jsonb_build_object('detachedAt',to_char(removed_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"'),
     'cloudRemovalAttempt',attempt))));
$function$
$object$;
 ELSIF encode(sha256(convert_to(actual,'UTF8')),'hex') NOT IN ('8c6bba7d87a8df9ae3129d622743954ada78b6fa1afdc62b23715a0dfa781b3c') THEN
  RAISE EXCEPTION 'Unqualified schema drift: personal_agent_cloud_removal_identity';
 END IF;
END
$object_guard$;

REVOKE ALL ON FUNCTION public."personal_agent_cloud_removal_identity"(jsonb, timestamp with time zone, text) FROM PUBLIC;

DO $pod_414$
BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN GRANT EXECUTE ON FUNCTION public."personal_agent_cloud_removal_identity"(jsonb, timestamp with time zone, text) TO service_role; END IF;
END
$pod_414$;

DO $object_guard$
DECLARE actual text;
BEGIN
 SELECT definition INTO actual FROM (SELECT pg_get_functiondef(p.oid) definition FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='personal_agent_cloud_removal_ready' AND pg_get_function_identity_arguments(p.oid)='') observed;
 IF actual IS NULL THEN
  EXECUTE $object$CREATE OR REPLACE FUNCTION public.personal_agent_cloud_removal_ready()
 RETURNS boolean
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
 SELECT public.azure_account_cleanup_ready() IS TRUE
 AND EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.personal_agent_cloud_removals'::regclass
  AND tgname='zz_personal_agent_cloud_removal' AND tgtype=31 AND tgenabled IN ('O','A')
  AND tgfoid='public.guard_personal_agent_cloud_removal()'::regprocedure AND tgnargs=0 AND tgqual IS NULL)
 AND EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.personal_agent_cloud_removals'::regclass
  AND tgname='zz_personal_agent_cloud_removal_history' AND tgtype=21 AND tgenabled IN ('O','A')
  AND tgfoid='public.guard_personal_agent_cloud_removal_history()'::regprocedure AND tgnargs=0 AND tgqual IS NULL);
$function$
$object$;
 ELSIF encode(sha256(convert_to(actual,'UTF8')),'hex') NOT IN ('d2beae9f4c902b938bdeb599eea90189d534e1415f514ec5ed495fad12adecf9') THEN
  RAISE EXCEPTION 'Unqualified schema drift: personal_agent_cloud_removal_ready';
 END IF;
END
$object_guard$;

REVOKE ALL ON FUNCTION public."personal_agent_cloud_removal_ready"() FROM PUBLIC;

DO $pod_414$
BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN GRANT EXECUTE ON FUNCTION public."personal_agent_cloud_removal_ready"() TO service_role; END IF;
END
$pod_414$;

DO $object_guard$
DECLARE actual text;
BEGIN
 SELECT definition INTO actual FROM (SELECT pg_get_functiondef(p.oid) definition FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='personal_agent_cloud_removal_replay_current' AND pg_get_function_identity_arguments(p.oid)='owner_id text, attempt text') observed;
 IF actual IS NULL THEN
  EXECUTE $object$CREATE OR REPLACE FUNCTION public.personal_agent_cloud_removal_replay_current(owner_id text, attempt text)
 RETURNS boolean
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
 SELECT public.personal_agent_cloud_removal_ready() IS TRUE AND EXISTS(
  SELECT 1 FROM public.personal_agent_cloud_removals c JOIN public.personal_agent_registry p ON p.user_id=c.user_id
  WHERE c.user_id=owner_id AND c.attempt_id=attempt AND c.completed_at IS NOT NULL AND p.status='unprovisioned'
  AND to_jsonb(p)-'updated_at'=to_jsonb(jsonb_populate_record(NULL::public.personal_agent_registry,c.released_identity))-'updated_at'
  AND NOT EXISTS(SELECT 1 FROM public.byoc_setup_jobs WHERE user_id=owner_id)
  AND NOT EXISTS(SELECT 1 FROM public.pod_migration_jobs WHERE user_id=owner_id)
  AND NOT EXISTS(SELECT 1 FROM public.personal_agent_standby_placements WHERE user_id=owner_id)
  AND NOT EXISTS(SELECT 1 FROM public.vault_keys v WHERE v.user_id=owner_id
   AND to_jsonb(v)->>'one_hosting_choice'='shared'
   AND (to_jsonb(v)->>'one_hosting_choice_at')::timestamptz >= date_trunc('second',c.completed_at)));
$function$
$object$;
 ELSIF encode(sha256(convert_to(actual,'UTF8')),'hex') NOT IN ('2077e2a2d37b17adb89fa8e783c85dc2c9eb1a832c56eede7b665d30299b482a') THEN
  RAISE EXCEPTION 'Unqualified schema drift: personal_agent_cloud_removal_replay_current';
 END IF;
END
$object_guard$;

REVOKE ALL ON FUNCTION public."personal_agent_cloud_removal_replay_current"(text, text) FROM PUBLIC;

DO $pod_414$
BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN GRANT EXECUTE ON FUNCTION public."personal_agent_cloud_removal_replay_current"(text, text) TO service_role; END IF;
END
$pod_414$;

DO $object_guard$
DECLARE actual text;
BEGIN
 SELECT definition INTO actual FROM (SELECT pg_get_functiondef(p.oid) definition FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='personal_agent_cloud_removal_review' AND pg_get_function_identity_arguments(p.oid)='r jsonb') observed;
 IF actual IS NULL THEN
  EXECUTE $object$CREATE OR REPLACE FUNCTION public.personal_agent_cloud_removal_review(r jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public'
AS $function$
DECLARE inventory jsonb; snapshot jsonb:=r->'registrySnapshot';
BEGIN
 IF jsonb_typeof(r) IS DISTINCT FROM 'object' OR r->>'ownerId' IS DISTINCT FROM snapshot->>'user_id'
 OR r->>'hushhId' IS DISTINCT FROM snapshot->>'hushh_id' THEN RETURN NULL; END IF;
 IF snapshot->>'deployment_target'='user_azure'
 OR public.azure_setup_never_deployed(r->>'ownerId',snapshot) IS TRUE THEN
  IF public.valid_azure_erasure_plan(r->>'ownerId',r->'azureTeardown'->'plan') IS NOT TRUE THEN RETURN NULL; END IF;
  RETURN r->'azureTeardown'->'plan';
 END IF;
 IF snapshot->>'deployment_target' IS DISTINCT FROM 'user_gcp' THEN RETURN NULL; END IF;
 inventory:=public.effective_erasure_substrate_inventory(r);
 IF jsonb_typeof(inventory) IS DISTINCT FROM 'object' THEN RETURN NULL; END IF;
 RETURN jsonb_build_object('version',1,'purpose','remove_cloud_keep_account',
  'ownerId',r->>'ownerId','attemptId',r->>'attemptId','placementEpoch',snapshot->'placement_epoch',
  'project',snapshot->>'user_cloud_project','region',snapshot->>'user_cloud_region',
  'service',snapshot->>'external_agent_id','serviceUid',snapshot->'backend_metadata'->>'serviceUid',
  'inventory',inventory,'termsVersion','gcp-owned-resources-retention-v1');
END;
$function$
$object$;
 ELSIF encode(sha256(convert_to(actual,'UTF8')),'hex') NOT IN ('72056c5bf6e239500bc512961e4319b29720fa3566764186e61624b98bf81169') THEN
  RAISE EXCEPTION 'Unqualified schema drift: personal_agent_cloud_removal_review';
 END IF;
END
$object_guard$;

REVOKE ALL ON FUNCTION public."personal_agent_cloud_removal_review"(jsonb) FROM PUBLIC;

DO $pod_414$
BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN GRANT EXECUTE ON FUNCTION public."personal_agent_cloud_removal_review"(jsonb) TO service_role; END IF;
END
$pod_414$;

DO $object_guard$
DECLARE actual text;
BEGIN
 SELECT definition INTO actual FROM (SELECT pg_get_functiondef(p.oid) definition FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='personal_agent_cloud_removed' AND pg_get_function_identity_arguments(p.oid)='owner_id text') observed;
 IF actual IS NULL THEN
  EXECUTE $object$CREATE OR REPLACE FUNCTION public.personal_agent_cloud_removed(owner_id text)
 RETURNS boolean
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
 SELECT public.personal_agent_cloud_removal_ready() IS TRUE AND EXISTS(
  SELECT 1 FROM public.personal_agent_cloud_removals c JOIN public.personal_agent_registry p ON p.user_id=c.user_id
  WHERE c.user_id=owner_id AND c.completed_at IS NOT NULL AND p.status='unprovisioned'
  AND to_jsonb(p)-'updated_at' = to_jsonb(jsonb_populate_record(NULL::public.personal_agent_registry,c.released_identity))-'updated_at');
$function$
$object$;
 ELSIF encode(sha256(convert_to(actual,'UTF8')),'hex') NOT IN ('9ab048b193d86b91021561b609cf24e0fce7a77e764cd0ead73824ba0b387c77') THEN
  RAISE EXCEPTION 'Unqualified schema drift: personal_agent_cloud_removed';
 END IF;
END
$object_guard$;

REVOKE ALL ON FUNCTION public."personal_agent_cloud_removed"(text) FROM PUBLIC;

DO $pod_414$
BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN GRANT EXECUTE ON FUNCTION public."personal_agent_cloud_removed"(text) TO service_role; END IF;
END
$pod_414$;

DO $object_guard$
DECLARE actual text;
BEGIN
 SELECT definition INTO actual FROM (SELECT pg_get_functiondef(p.oid) definition FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='personal_agent_erasure_archive' AND pg_get_function_identity_arguments(p.oid)='r jsonb, history jsonb') observed;
 IF actual IS NULL THEN
  EXECUTE $object$CREATE OR REPLACE FUNCTION public.personal_agent_erasure_archive(r jsonb, history jsonb)
 RETURNS jsonb
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public'
AS $function$
 SELECT jsonb_build_object(
  'version',1,'ownerId',r->>'ownerId','hushhId',r->>'hushhId','attemptId',r->>'attemptId',
  'project',r->'registrySnapshot'->>'user_cloud_project',
  'reservationSha256',encode(sha256(convert_to(r::text,'UTF8')),'hex'),
  'authorizationHistorySha256',encode(sha256(convert_to(history::text,'UTF8')),'hex'),
  'receipts',jsonb_build_object(
   'memoryDeletion',r->'memoryDeletion','computeDeletion',r->'computeDeletion',
   'writerDisabled',r->'writerDisabled','bucketDeletion',r->'bucketDeletion',
   'mailDeletion',jsonb_build_object(
    'cloud_scheduler_job',r->'mailErasure'->'cloud_scheduler_job'->'deletion',
    'pubsub_subscription',r->'mailErasure'->'pubsub_subscription'->'deletion',
    'pubsub_topic',r->'mailErasure'->'pubsub_topic'->'deletion') ||
    -- 956: preserve every independent resource's qualified stages in the archive.
    CASE WHEN EXISTS(SELECT 1 FROM jsonb_each(coalesce(r->'mailErasure','{}'::jsonb)) x WHERE x.value ? 'resources')
     THEN jsonb_build_object('resourcesByKind',r->'mailErasure') ELSE '{}'::jsonb END,
   'kmsCompletion',r->'kmsErasure'->'completion','secretDeletion',r->'secretErasure'->'deletion',
   'accountDeletion',r->'accountErasure'->'deletion',
   'runtimeGrantDeletion',r->'runtimeGrantErasure'->'deletion',
   'repositoryGrantDeletion',r->'repositoryGrantErasure'->'deletion',
   'repositoryRetention',r->'repositoryRetention',
   'bootstrapGrantRelease',r->'bootstrapGrantRelease',
   'bootstrapGrantErasure',r->'bootstrapGrantErasure') ||
   CASE WHEN EXISTS(SELECT 1 FROM jsonb_array_elements(r->'substrateInventory'->'plannedResources') x WHERE x->>'type'='cloud_tasks_queue')
    THEN jsonb_build_object('filesErasure',r->'filesErasure') ELSE '{}'::jsonb END
   -- 954: keep the person's never-hosted receipt; absent (no key) on every hosted archive.
   || jsonb_strip_nulls(jsonb_build_object('neverHosted',r->'neverHosted'))
   || CASE WHEN jsonb_typeof(r->'azureTeardown')='object'
      THEN jsonb_build_object('azureCleanup',r->'azureTeardown',
       'agentCryptoErase',r->'agentCryptoErase','ownerAccessErasure',r->'ownerAccessErasure') ELSE '{}'::jsonb END
   || CASE WHEN jsonb_array_length(coalesce(r->'substrateInventory'->'operatorBindingObservations','[]'::jsonb))>0
    THEN jsonb_build_object('operatorNotificationCustody',jsonb_build_object(
     'bindings',r->'substrateInventory'->'operatorBindingObservations',
     'topics',(SELECT coalesce(jsonb_agg(x),'[]'::jsonb)
      FROM jsonb_array_elements(r->'substrateInventory'->'resourceObservations') x
      WHERE x->>'type'='pubsub_topic' AND starts_with(x->>'id','projects/'))))
    ELSE '{}'::jsonb END
   || CASE WHEN r->'runtimeGrantErasure' ? 'quota'
    THEN jsonb_build_object('runtimeQuotaGrantDeletion',r->'runtimeGrantErasure'->'quota'->'deletion') ELSE '{}'::jsonb END);
$function$
$object$;
 ELSIF encode(sha256(convert_to(actual,'UTF8')),'hex') NOT IN ('e43bad73e40984d01c4ea5a01872dc76ce3ba77fce05c48eaffd95118d398685') THEN
  RAISE EXCEPTION 'Unqualified schema drift: personal_agent_erasure_archive';
 END IF;
END
$object_guard$;

REVOKE ALL ON FUNCTION public."personal_agent_erasure_archive"(jsonb, jsonb) FROM PUBLIC;

DO $pod_414$
BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN GRANT EXECUTE ON FUNCTION public."personal_agent_erasure_archive"(jsonb, jsonb) TO service_role; END IF;
END
$pod_414$;

DO $object_guard$
DECLARE actual text;
BEGIN
 SELECT definition INTO actual FROM (SELECT pg_get_functiondef(p.oid) definition FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='personal_agent_erasure_archived' AND pg_get_function_identity_arguments(p.oid)='owner_id text, r jsonb, history jsonb') observed;
 IF actual IS NULL THEN
  EXECUTE $object$CREATE OR REPLACE FUNCTION public.personal_agent_erasure_archived(owner_id text, r jsonb, history jsonb DEFAULT NULL::jsonb)
 RETURNS boolean
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
 SELECT jsonb_typeof(r)='object' AND r->>'ownerId'=owner_id AND coalesce(r->>'attemptId','')<>''
 AND (
  (EXISTS(SELECT 1 FROM public.personal_agent_deletion_tombstones t WHERE t.status='erasure_completed'
    AND t.metadata->>'ownerId'=owner_id AND t.hushh_id=r->>'hushhId' AND t.metadata->>'attemptId'=r->>'attemptId'
    AND t.metadata->>'reservationSha256'=encode(sha256(convert_to(r::text,'UTF8')),'hex')
    AND (history IS NULL OR t.metadata->>'authorizationHistorySha256'=encode(sha256(convert_to(history::text,'UTF8')),'hex')))
   AND EXISTS(SELECT 1 FROM public.account_deletion_tombstones WHERE cleanup_intent_kind='full_account'
    AND user_id_hash='sha256:'||encode(sha256(convert_to(owner_id,'UTF8')),'hex')))
  OR (public.personal_agent_cloud_removal_ready() IS TRUE AND EXISTS(
   SELECT 1 FROM public.personal_agent_cloud_removals c WHERE c.user_id=owner_id AND c.attempt_id=r->>'attemptId'
    AND c.completed_at IS NOT NULL AND c.archive->>'hushhId'=r->>'hushhId'
    AND c.snapshot_sha256=encode(sha256(convert_to((r->'registrySnapshot')::text,'UTF8')),'hex')
    AND c.placement_epoch=(r->'registrySnapshot'->>'placement_epoch')::bigint
    AND c.archive->>'reservationSha256'=encode(sha256(convert_to(r::text,'UTF8')),'hex')
    AND (history IS NULL OR c.archive->>'authorizationHistorySha256'=encode(sha256(convert_to(history::text,'UTF8')),'hex')))))
 AND EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.personal_agent_deletion_tombstones'::regclass
  AND tgname='zz_personal_agent_erasure_archive' AND tgtype=31 AND tgenabled IN ('O','A')
  AND tgfoid='public.guard_personal_agent_erasure_archive()'::regprocedure AND tgnargs=0 AND tgqual IS NULL);
$function$
$object$;
 ELSIF encode(sha256(convert_to(actual,'UTF8')),'hex') NOT IN ('869752af19ff5735ad84cfefcb7cdfdc3036646bf137d64e16e04ce57f984bab') THEN
  RAISE EXCEPTION 'Unqualified schema drift: personal_agent_erasure_archived';
 END IF;
END
$object_guard$;

REVOKE ALL ON FUNCTION public."personal_agent_erasure_archived"(text, jsonb, jsonb) FROM PUBLIC;

DO $pod_414$
BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN GRANT EXECUTE ON FUNCTION public."personal_agent_erasure_archived"(text, jsonb, jsonb) TO service_role; END IF;
END
$pod_414$;

DO $object_guard$
DECLARE actual text;
BEGIN
 SELECT definition INTO actual FROM (SELECT pg_get_functiondef(p.oid) definition FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='personal_agent_erasure_complete' AND pg_get_function_identity_arguments(p.oid)='owner_id text') observed;
 IF actual IS NULL THEN
  EXECUTE $object$CREATE OR REPLACE FUNCTION public.personal_agent_erasure_complete(owner_id text)
 RETURNS boolean
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE row_state public.personal_agent_registry%ROWTYPE; setup public.byoc_setup_jobs%ROWTYPE;
 r jsonb; release jsonb; expected_release jsonb; item record; stages jsonb; wanted jsonb;
 archive jsonb; table_name text; never_hosted boolean; azure_hosted boolean; group_scope text;
BEGIN
 IF owner_id IS NULL OR btrim(owner_id)='' OR current_setting('transaction_isolation')<>'read committed' THEN RETURN false; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(owner_id,171));
 PERFORM pg_advisory_xact_lock(hashtextextended(owner_id,198));
 SELECT * INTO row_state FROM public.personal_agent_registry WHERE user_id=owner_id FOR UPDATE;
 IF NOT FOUND OR row_state.status IS DISTINCT FROM 'suspended' THEN RETURN false; END IF;
 -- Own setup writers acquire their tuple before project205. Prelock it here,
 -- before project exclusivity, because finalization will delete it later.
 SELECT * INTO setup FROM public.byoc_setup_jobs WHERE user_id=owner_id FOR UPDATE;
 IF NOT FOUND THEN RETURN false; END IF;
 r:=row_state.backend_metadata->'erasure'; release:=r->'bootstrapGrantRelease';
 azure_hosted:=coalesce(r->'registrySnapshot'->>'deployment_target'='user_azure',false)
  OR public.azure_setup_never_deployed(owner_id,r->'registrySnapshot') IS TRUE;
 IF (NOT azure_hosted AND setup.status IS DISTINCT FROM 'recorded')
 OR (azure_hosted AND setup.status NOT IN ('recorded','failed')) THEN RETURN false; END IF;
 -- 954: a never-hosted reservation completes only on its SQL-re-derived evidence.
 never_hosted:=coalesce(r ? 'neverHosted',false);
 IF never_hosted AND public.erasure_never_hosted_admitted(owner_id,r) IS DISTINCT FROM true THEN RETURN false; END IF;
 IF r->>'ownerId' IS DISTINCT FROM owner_id OR r->'registrySnapshot'->>'user_id' IS DISTINCT FROM owner_id
 OR r->>'hushhId' IS DISTINCT FROM row_state.hushh_id OR row_state.hushh_id IS NULL OR row_state.hushh_id=''
 OR r->>'attemptId' IS NULL OR r->>'attemptId'=''
 OR (NOT azure_hosted AND jsonb_typeof(release) IS DISTINCT FROM 'object')
 OR r ?| ARRAY['lateUpgradeAcknowledgement','lateProvisionAcknowledgement']
 OR nullif(r->'registrySnapshot'->'backend_metadata'->>'upgradeLease','') IS NOT NULL
 OR (NOT azure_hosted AND NOT never_hosted AND r->'registrySnapshot'->'backend_metadata'->'provisionAttempt'->>'phase' IS DISTINCT FROM 'provisioned')
 OR (NOT azure_hosted AND setup.project_id IS DISTINCT FROM r->'registrySnapshot'->>'user_cloud_project') THEN RETURN false; END IF;
 IF azure_hosted THEN
  -- Nonblocking: actual workers hold206 until their real thread and exit persistence finish.
  IF (public.byoc_azure_worker_session_held(owner_id) IS TRUE
    AND r->'azureTeardown'->'worker'->'backendPid'=to_jsonb(pg_backend_pid()))
   OR NOT pg_try_advisory_xact_lock(hashtextextended(owner_id,206))
   OR public.azure_erasure_resources_complete(owner_id,r) IS NOT TRUE THEN RETURN false; END IF;
  group_scope:=setup.project_id;
  PERFORM pg_advisory_xact_lock(hashtextextended(group_scope,205));
  IF EXISTS(SELECT 1 FROM public.byoc_setup_jobs WHERE user_id<>owner_id AND project_id=group_scope)
   OR EXISTS(SELECT 1 FROM public.personal_agent_registry WHERE user_id<>owner_id
    AND '/subscriptions/'||user_cloud_subscription_id||'/resourceGroups/'||user_cloud_resource_group=group_scope)
  THEN RETURN false; END IF;
 ELSE
  IF public.project_grant_release_is_exclusive(owner_id,r->'grantRelease'->>'project') IS DISTINCT FROM true THEN RETURN false; END IF;
 END IF;
 -- The canonical identity barrier must cover late registry/setup/log/migration insertion.
 FOREACH table_name IN ARRAY ARRAY['personal_agent_registry','byoc_setup_jobs','pod_lifecycle_events','pod_migration_jobs'] LOOP
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid=('public.'||table_name)::regclass
   AND tgname='trg_reject_deleted_account_insert' AND tgtype=7 AND tgenabled IN ('O','A')
   AND tgfoid='public.reject_deleted_account_identity_write()'::regprocedure
   AND tgnargs=1 AND tgargs=decode('757365725f696400','hex') AND tgqual IS NULL) THEN RETURN false; END IF;
 END LOOP;
 IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid='public.personal_agent_deletion_tombstones'::regclass
  AND tgname='zz_personal_agent_erasure_archive' AND tgtype=31 AND tgenabled IN ('O','A')
  AND tgfoid='public.guard_personal_agent_erasure_archive()'::regprocedure AND tgqual IS NULL AND tgnargs=0) THEN RETURN false; END IF;
 IF EXISTS (SELECT 1 FROM public.pod_migration_jobs WHERE user_id=owner_id)
 OR EXISTS (SELECT 1 FROM public.pod_lifecycle_events WHERE user_id=owner_id AND hushh_id IS NOT NULL AND hushh_id<>row_state.hushh_id)
 OR jsonb_typeof(setup.authorization_attempts) IS DISTINCT FROM 'object'
 OR EXISTS (SELECT 1 FROM jsonb_each(setup.authorization_attempts) h
   WHERE h.value->'intent'->>'project' IS DISTINCT FROM setup.project_id OR NOT h.value ? 'receipt') THEN RETURN false; END IF;
 IF NOT azure_hosted THEN
 IF NOT never_hosted AND (public.erasure_planned_resources_covered(r) IS DISTINCT FROM true
 OR public.valid_erasure_repository_grant_receipt(r,'deletion',r->'repositoryGrantErasure'->'deletion') IS DISTINCT FROM true
 OR public.valid_erasure_repository_retention(r,r->'repositoryRetention') IS DISTINCT FROM true) THEN RETURN false; END IF;
 expected_release:=public.expected_erasure_bootstrap_release(owner_id,r,release->>'recoveryMember');
 IF expected_release IS NULL OR release IS DISTINCT FROM expected_release
 OR jsonb_typeof(r->'bootstrapGrantErasure') IS DISTINCT FROM 'object'
 OR (SELECT array_agg(key ORDER BY key) FROM jsonb_each(r->'bootstrapGrantErasure')) IS DISTINCT FROM
    (SELECT array_agg(key ORDER BY key) FROM jsonb_each(release->'groups')) THEN RETURN false; END IF;
 FOR item IN SELECT * FROM jsonb_each(release->'groups') LOOP
  stages:=r->'bootstrapGrantErasure'->item.key;
  wanted:=jsonb_build_object('ownerId',owner_id,'attemptId',r->>'attemptId',
   'bootstrapIdentity',item.value->'bootstrapIdentity','bindingObservation',item.value->'bindingObservation');
  IF jsonb_typeof(stages) IS DISTINCT FROM 'object' OR stages-ARRAY['admission','acknowledgement','deletion']<>'{}'::jsonb
   OR stages->'admission' IS DISTINCT FROM wanted||jsonb_build_object('status','admitted')
   OR stages->'deletion' IS DISTINCT FROM wanted||jsonb_build_object('status','observed_absent')
   OR (stages ? 'acknowledgement' AND stages->'acknowledgement' IS DISTINCT FROM wanted||jsonb_build_object('status','acknowledged')) THEN RETURN false; END IF;
 END LOOP;
 END IF;
 archive:=public.personal_agent_erasure_archive(r,setup.authorization_attempts);
 IF octet_length(archive::text)>2097152 THEN RETURN false; END IF;
 IF EXISTS (SELECT 1 FROM public.personal_agent_deletion_tombstones t WHERE
  (t.hushh_id=row_state.hushh_id OR t.metadata->>'ownerId'=owner_id OR t.metadata->>'user_id'=owner_id)
  AND (t.status IS DISTINCT FROM 'erasure_completed' OR t.metadata IS DISTINCT FROM archive
       OR t.external_agent_id IS DISTINCT FROM row_state.external_agent_id)) THEN RETURN false; END IF;
 RETURN true;
END;
$function$
$object$;
 ELSIF encode(sha256(convert_to(actual,'UTF8')),'hex') NOT IN ('d1e653a9c5323c12e558ed2b2d5483487e50d745424f5d512b91c687cd94dd2d') THEN
  RAISE EXCEPTION 'Unqualified schema drift: personal_agent_erasure_complete';
 END IF;
END
$object_guard$;

REVOKE ALL ON FUNCTION public."personal_agent_erasure_complete"(text) FROM PUBLIC;

DO $pod_414$
BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN GRANT EXECUTE ON FUNCTION public."personal_agent_erasure_complete"(text) TO service_role; END IF;
END
$pod_414$;

DO $object_guard$
DECLARE actual text;
BEGIN
 SELECT definition INTO actual FROM (SELECT pg_get_functiondef(p.oid) definition FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='pod_lifecycle_notify' AND pg_get_function_identity_arguments(p.oid)='') observed;
 IF actual IS NULL THEN
  EXECUTE $object$CREATE OR REPLACE FUNCTION public.pod_lifecycle_notify()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
  payload TEXT;
BEGIN
  payload := json_build_object('user_id', NEW.user_id, 'seq', NEW.seq)::TEXT;
  PERFORM pg_notify('pod_lifecycle_new', payload);
  RETURN NEW;
END;
$function$
$object$;
 ELSIF encode(sha256(convert_to(actual,'UTF8')),'hex') NOT IN ('d2f2a99e76f30b6ea14b27269d615826009aa16b411ea1fbb7bcc639135f7646') THEN
  RAISE EXCEPTION 'Unqualified schema drift: pod_lifecycle_notify';
 END IF;
END
$object_guard$;

REVOKE ALL ON FUNCTION public."pod_lifecycle_notify"() FROM PUBLIC;

DO $pod_414$
BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN GRANT EXECUTE ON FUNCTION public."pod_lifecycle_notify"() TO service_role; END IF;
END
$pod_414$;

DO $object_guard$
DECLARE actual text;
BEGIN
 SELECT definition INTO actual FROM (SELECT pg_get_functiondef(p.oid) definition FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='project_grant_release_is_exclusive' AND pg_get_function_identity_arguments(p.oid)='owner_id text, target_project text') observed;
 IF actual IS NULL THEN
  EXECUTE $object$CREATE OR REPLACE FUNCTION public.project_grant_release_is_exclusive(owner_id text, target_project text)
 RETURNS boolean
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
BEGIN
 IF target_project IS NULL OR target_project !~ '^[a-z][a-z0-9-]{4,61}[a-z0-9]$' OR current_setting('transaction_isolation') <> 'read committed' THEN RETURN false; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(target_project,205));
 IF (SELECT count(*) FROM pg_trigger WHERE
  (tgrelid='public.personal_agent_registry'::regclass AND tgname='zx_project_grant_registry' AND tgfoid='public.guard_project_grant_registry_admission()'::regprocedure AND tgtype=23)
  OR (tgrelid='public.byoc_setup_jobs'::regclass AND tgname='zx_project_grant_setup' AND tgfoid='public.guard_project_grant_setup_admission()'::regprocedure AND tgtype=23)
  OR (tgrelid='public.personal_agent_registry'::regclass AND tgname='zz_personal_agent_erasure_registry' AND tgfoid='public.guard_personal_agent_erasure_registry()'::regprocedure AND tgtype=27)
  OR (tgrelid='public.byoc_setup_jobs'::regclass AND tgname='zz_byoc_authorization_attempts' AND tgfoid='public.guard_byoc_authorization_attempts()'::regprocedure AND tgtype=31)) <> 4 THEN RETURN false; END IF;
 IF EXISTS (SELECT 1 FROM pg_trigger WHERE tgname IN ('zx_project_grant_registry','zx_project_grant_setup','zz_personal_agent_erasure_registry','zz_byoc_authorization_attempts') AND tgrelid IN ('public.personal_agent_registry'::regclass,'public.byoc_setup_jobs'::regclass) AND (tgenabled NOT IN ('O','A') OR tgnargs<>0 OR tgqual IS NOT NULL)) THEN RETURN false; END IF;
 -- Never lock other owners' rows under the project lock. Unresolved users retain grants.
 IF EXISTS (SELECT 1 FROM public.personal_agent_registry x WHERE x.user_id<>owner_id AND
   (x.user_cloud_project=target_project OR x.backend_metadata->'provisionAttempt'->'intent'->>'user_cloud_project'=target_project))
 OR EXISTS (SELECT 1 FROM public.byoc_setup_jobs j WHERE j.project_id=target_project AND (j.user_id<>owner_id OR j.status IS DISTINCT FROM 'recorded')) THEN RETURN false; END IF;
 IF EXISTS (SELECT 1 FROM public.byoc_setup_jobs j CROSS JOIN LATERAL jsonb_each(j.authorization_attempts) a WHERE a.value->'intent'->>'project'=target_project AND (j.user_id<>owner_id OR NOT (a.value ? 'receipt'))) THEN RETURN false; END IF;
 RETURN true;
END;
$function$
$object$;
 ELSIF encode(sha256(convert_to(actual,'UTF8')),'hex') NOT IN ('2443acc5b64dd4866dba2f0814a1abad38f031dee12f1f4e2f69e78fb4a8a9f9') THEN
  RAISE EXCEPTION 'Unqualified schema drift: project_grant_release_is_exclusive';
 END IF;
END
$object_guard$;

REVOKE ALL ON FUNCTION public."project_grant_release_is_exclusive"(text, text) FROM PUBLIC;

DO $pod_414$
BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN GRANT EXECUTE ON FUNCTION public."project_grant_release_is_exclusive"(text, text) TO service_role; END IF;
END
$pod_414$;

DO $object_guard$
DECLARE actual text;
BEGIN
 SELECT definition INTO actual FROM (SELECT pg_get_functiondef(p.oid) definition FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='publish_personal_agent_notification_checkpoint' AND pg_get_function_identity_arguments(p.oid)='owner_id text, operation_kind text, attempt_id text, operation_id text, expected_generation bigint, checkpoint jsonb') observed;
 IF actual IS NULL THEN
  EXECUTE $object$CREATE OR REPLACE FUNCTION public.publish_personal_agent_notification_checkpoint(owner_id text, operation_kind text, attempt_id text, operation_id text, expected_generation bigint, checkpoint jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE current_row public.personal_agent_registry%ROWTYPE; metadata jsonb; previous jsonb; inventory jsonb; reservation jsonb; bound jsonb; marker text; notification_marker text;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended(owner_id,171));
 PERFORM pg_advisory_xact_lock(hashtextextended(owner_id,198));
 SELECT * INTO current_row FROM public.personal_agent_registry WHERE user_id=owner_id FOR UPDATE;
 IF NOT FOUND OR checkpoint->>'ownerId' IS DISTINCT FROM owner_id OR checkpoint->>'kind' IS DISTINCT FROM operation_kind
 OR checkpoint->>'attemptId' IS DISTINCT FROM attempt_id OR checkpoint->>'operationId' IS DISTINCT FROM operation_id
 OR expected_generation IS NULL OR expected_generation<0 THEN RETURN NULL; END IF;
 metadata:=current_row.backend_metadata;
 IF public.notification_checkpoint_admission_ready() IS DISTINCT FROM true THEN RETURN NULL; END IF;
 IF metadata ? 'erasure' THEN
  reservation:=metadata->'erasure'; previous:=reservation->'registrySnapshot'->'backend_metadata'->'notificationCheckpoint';
  IF current_row.status IS DISTINCT FROM 'suspended' OR reservation->>'ownerId' IS DISTINCT FROM owner_id
   OR (previous->>'generation')::bigint IS DISTINCT FROM expected_generation
   OR reservation ? 'substrateInventory' OR public.valid_erasure_notification_observation(reservation,checkpoint) IS DISTINCT FROM true THEN RETURN NULL; END IF;
  IF reservation ? 'lateNotificationObservation' THEN RETURN NULL; END IF;
  UPDATE public.personal_agent_registry SET backend_metadata=jsonb_set(backend_metadata,ARRAY['erasure','lateNotificationObservation'],checkpoint,true) WHERE user_id=owner_id;
  RETURN NULL; -- cleanup evidence never grants continued provider execution
 END IF;
 IF EXISTS(SELECT 1 FROM public.account_deletion_tombstones WHERE user_id_hash='sha256:'||encode(sha256(convert_to(owner_id,'UTF8')),'hex')) THEN RETURN NULL; END IF;
 previous:=metadata->'notificationCheckpoint';
 IF coalesce((previous->>'generation')::bigint,0)<>expected_generation THEN RETURN NULL; END IF;
 bound:=checkpoint;
 IF operation_kind='provision' AND checkpoint->>'step' IN ('gmail_runtime_configuration','gmail_direct_invoker','mail_subscription_configuration','watch_renew_job') THEN
  IF checkpoint->>'serviceUid' IS NOT NULL AND checkpoint->>'serviceUid' IS DISTINCT FROM metadata->'provisionAttempt'->'evidence'->'host_requested'->'creationAcknowledgement'->>'serviceUid' THEN RETURN NULL; END IF;
  bound:=jsonb_set(bound,'{serviceUid}',metadata->'provisionAttempt'->'evidence'->'host_requested'->'creationAcknowledgement'->'serviceUid',true);
 END IF;
 IF public.valid_personal_agent_notification_checkpoint(to_jsonb(current_row),bound,previous) IS DISTINCT FROM true THEN RETURN NULL; END IF;
 inventory:=public.notification_checkpoint_inventory(metadata->'substrateReceipt',bound);
 IF inventory IS NULL THEN RETURN NULL; END IF;
 notification_marker:=current_setting('hussh.notification_generation',true);
 PERFORM set_config('hussh.notification_generation',expected_generation::text,true);
 marker:=current_setting('hussh.provision_attempt',true);
 PERFORM set_config('hussh.provision_attempt',coalesce(metadata->'provisionAttempt'->>'attemptId',''),true);
 UPDATE public.personal_agent_registry SET backend_metadata=backend_metadata||jsonb_build_object('notificationCheckpoint',bound,'substrateReceipt',inventory) WHERE user_id=owner_id;
 PERFORM set_config('hussh.provision_attempt',coalesce(marker,''),true);
 PERFORM set_config('hussh.notification_generation',coalesce(notification_marker,''),true);
 RETURN jsonb_build_object('checkpoint',bound,'inventory',inventory);
END;
$function$
$object$;
 ELSIF encode(sha256(convert_to(actual,'UTF8')),'hex') NOT IN ('e669bc8629d806421ff40ba31ab2e75a4168b2c8bd99bd74424ac0dc34c147bf') THEN
  RAISE EXCEPTION 'Unqualified schema drift: publish_personal_agent_notification_checkpoint';
 END IF;
END
$object_guard$;

REVOKE ALL ON FUNCTION public."publish_personal_agent_notification_checkpoint"(text, text, text, text, bigint, jsonb) FROM PUBLIC;

DO $pod_414$
BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN GRANT EXECUTE ON FUNCTION public."publish_personal_agent_notification_checkpoint"(text, text, text, text, bigint, jsonb) TO service_role; END IF;
END
$pod_414$;

DO $object_guard$
DECLARE actual text;
BEGIN
 SELECT definition INTO actual FROM (SELECT pg_get_functiondef(p.oid) definition FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='publish_personal_agent_provision' AND pg_get_function_identity_arguments(p.oid)='owner_id text, attempt_id text, expected_phase text, next_phase text, evidence jsonb') observed;
 IF actual IS NULL THEN
  EXECUTE $object$CREATE OR REPLACE FUNCTION public.publish_personal_agent_provision(owner_id text, attempt_id text, expected_phase text, next_phase text, evidence jsonb)
 RETURNS boolean
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
  current_row public.personal_agent_registry%ROWTYPE;
  attempt jsonb;
  prior_setting text;
  fields jsonb;
  target public.personal_agent_registry%ROWTYPE;
BEGIN
  IF owner_id IS NULL OR btrim(owner_id)='' OR attempt_id IS NULL
     OR attempt_id !~ '^[a-f0-9]{32}$' OR expected_phase IS NULL OR next_phase IS NULL
     OR jsonb_typeof(evidence) IS DISTINCT FROM 'object' OR octet_length(evidence::text)>65536
     OR evidence ?| ARRAY['provisionAttempt','erasure','upgradeLease','observed']
     OR NOT ((expected_phase='reserved' AND next_phase IN ('substrate','failed'))
          OR (expected_phase='substrate' AND next_phase IN ('host_requested','failed'))
          OR (expected_phase='host_requested' AND next_phase IN ('host_requested','host_acknowledged','failed'))
          OR (expected_phase='host_acknowledged' AND next_phase IN ('connecting','failed'))
          OR (expected_phase='connecting' AND next_phase IN ('connecting','provisioned','failed'))) THEN
    RETURN false;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(owner_id,171));
  PERFORM pg_advisory_xact_lock(hashtextextended(owner_id,198));
  SELECT * INTO current_row FROM public.personal_agent_registry WHERE user_id=owner_id FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;
  attempt := current_row.backend_metadata->'provisionAttempt';
  IF attempt->>'ownerId' IS DISTINCT FROM owner_id OR attempt->>'attemptId' IS DISTINCT FROM attempt_id
     OR attempt->>'phase' IS DISTINCT FROM expected_phase OR current_row.backend_metadata ? 'erasure' THEN
    RETURN false;
  END IF;
  fields := coalesce(evidence->'registry','{}'::jsonb);
  IF expected_phase='host_requested' AND next_phase='host_requested' THEN
    IF evidence - 'creationAcknowledgement' <> '{}'::jsonb
       OR jsonb_typeof(evidence->'creationAcknowledgement') IS DISTINCT FROM 'object'
       OR coalesce(evidence->'creationAcknowledgement'->>'service','')=''
       OR coalesce(evidence->'creationAcknowledgement'->>'serviceUid','')='' THEN RETURN false; END IF;
    IF attempt->'evidence'->'host_requested' ? 'creationAcknowledgement' THEN
      RETURN attempt->'evidence'->'host_requested'->'creationAcknowledgement' = evidence->'creationAcknowledgement';
    END IF;
  END IF;
  IF jsonb_typeof(fields) IS DISTINCT FROM 'object'
     OR fields - ARRAY['pod_pubkey','pod_key_id','pod_key_wrapping_alg','external_agent_id',
        'a2a_route','backend','backend_metadata','attestation_ref','liveness_mode'] <> '{}'::jsonb
     OR (fields ? 'backend_metadata' AND (
         jsonb_typeof(fields->'backend_metadata') IS DISTINCT FROM 'object'
         OR fields->'backend_metadata' ?| ARRAY['provisionAttempt','erasure','upgradeLease','observed']))
     OR (evidence ? 'expectedPodKey' AND evidence->>'expectedPodKey' IS DISTINCT FROM current_row.pod_pubkey)
  THEN RETURN false; END IF;
  target := jsonb_populate_record(current_row,fields);
  prior_setting := current_setting('hussh.provision_attempt',true);
  PERFORM set_config('hussh.provision_attempt',attempt_id,true);
  UPDATE public.personal_agent_registry SET backend_metadata = jsonb_set(
      backend_metadata || coalesce(fields->'backend_metadata','{}'::jsonb),
      '{provisionAttempt}',attempt || CASE WHEN next_phase='failed' THEN jsonb_build_object('failedFrom',expected_phase) ELSE '{}'::jsonb END || jsonb_build_object(
        'phase',next_phase,'evidence',coalesce(attempt->'evidence','{}'::jsonb) ||
        jsonb_build_object(next_phase,coalesce(attempt->'evidence'->next_phase,'{}'::jsonb) || evidence))),
      status=CASE WHEN next_phase='failed' THEN 'suspended'
                  WHEN next_phase IN ('connecting','provisioned') THEN next_phase ELSE status END,
      pod_pubkey=target.pod_pubkey,pod_key_id=target.pod_key_id,
      pod_key_wrapping_alg=target.pod_key_wrapping_alg,external_agent_id=target.external_agent_id,
      a2a_route=target.a2a_route,backend=target.backend,attestation_ref=target.attestation_ref,
      liveness_mode=target.liveness_mode,
      provisioned_at=CASE WHEN next_phase='provisioned' THEN coalesce(provisioned_at,clock_timestamp())
                          ELSE provisioned_at END,
      updated_at=clock_timestamp()
    WHERE user_id=owner_id;
  PERFORM set_config('hussh.provision_attempt',coalesce(prior_setting,''),true);
  RETURN true;
END;
$function$
$object$;
 ELSIF encode(sha256(convert_to(actual,'UTF8')),'hex') NOT IN ('797112bfe0b6519006dce20043d63f995cbe9c1046a8ed49e15d89762b9155bf') THEN
  RAISE EXCEPTION 'Unqualified schema drift: publish_personal_agent_provision';
 END IF;
END
$object_guard$;

REVOKE ALL ON FUNCTION public."publish_personal_agent_provision"(text, text, text, text, jsonb) FROM PUBLIC;

DO $pod_414$
BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN GRANT EXECUTE ON FUNCTION public."publish_personal_agent_provision"(text, text, text, text, jsonb) TO service_role; END IF;
END
$pod_414$;

DO $object_guard$
DECLARE actual text;
BEGIN
 SELECT definition INTO actual FROM (SELECT pg_get_functiondef(p.oid) definition FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='reserve_azure_account_cleanup' AND pg_get_function_identity_arguments(p.oid)='owner_id text, expected_snapshot_sha256 text') observed;
 IF actual IS NULL THEN
  EXECUTE $object$CREATE OR REPLACE FUNCTION public.reserve_azure_account_cleanup(owner_id text, expected_snapshot_sha256 text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE agent public.personal_agent_registry%ROWTYPE; snapshot jsonb; r jsonb;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended(owner_id,171));
 PERFORM pg_advisory_xact_lock(hashtextextended(owner_id,198));
 SELECT * INTO agent FROM public.personal_agent_registry WHERE user_id=owner_id FOR UPDATE;
 IF NOT FOUND THEN RETURN NULL; END IF;
 IF (agent.backend_metadata ? 'erasure') IS NOT TRUE AND (expected_snapshot_sha256 IS NULL
  OR expected_snapshot_sha256 IS DISTINCT FROM public.azure_cleanup_candidate_digest(to_jsonb(agent))) THEN RETURN NULL; END IF;
 PERFORM 1 FROM public.byoc_setup_jobs WHERE user_id=owner_id FOR UPDATE;
 IF NOT pg_try_advisory_xact_lock(hashtextextended(owner_id,206)) THEN RETURN NULL; END IF;
 snapshot:=coalesce(agent.backend_metadata->'erasure'->'registrySnapshot',to_jsonb(agent));
 IF (snapshot->>'deployment_target' IS DISTINCT FROM 'user_azure'
 OR snapshot->>'backend' IS DISTINCT FROM 'user_azure'
 OR snapshot->>'status' IS DISTINCT FROM 'provisioned')
 AND public.azure_setup_never_deployed(owner_id,snapshot) IS NOT TRUE THEN RETURN NULL; END IF;
 r:=public.reserve_personal_agent_erasure(owner_id,replace(gen_random_uuid()::text,'-',''));
 IF r IS NULL OR public.azure_erasure_context(owner_id) IS NULL THEN
  RAISE EXCEPTION 'Azure cleanup reservation cannot be qualified';
 END IF;
 RETURN r;
END;
$function$
$object$;
 ELSIF encode(sha256(convert_to(actual,'UTF8')),'hex') NOT IN ('54cb145ac926c586598465c60bece907d6a82b824dc1c31607ebebdbc2f048b4') THEN
  RAISE EXCEPTION 'Unqualified schema drift: reserve_azure_account_cleanup';
 END IF;
END
$object_guard$;

REVOKE ALL ON FUNCTION public."reserve_azure_account_cleanup"(text, text) FROM PUBLIC;

DO $pod_414$
BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN GRANT EXECUTE ON FUNCTION public."reserve_azure_account_cleanup"(text, text) TO service_role; END IF;
END
$pod_414$;

DO $object_guard$
DECLARE actual text;
BEGIN
 SELECT definition INTO actual FROM (SELECT pg_get_functiondef(p.oid) definition FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='reserve_erasure_bootstrap_grants' AND pg_get_function_identity_arguments(p.oid)='owner_id text, attempt_id text, expected jsonb, recovery_member text') observed;
 IF actual IS NULL THEN
  EXECUTE $object$CREATE OR REPLACE FUNCTION public.reserve_erasure_bootstrap_grants(owner_id text, attempt_id text, expected jsonb, recovery_member text)
 RETURNS boolean
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE current_row public.personal_agent_registry%ROWTYPE; r jsonb; receipt jsonb;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended(owner_id,171));
 PERFORM pg_advisory_xact_lock(hashtextextended(owner_id,198));
 SELECT * INTO current_row FROM public.personal_agent_registry WHERE user_id=owner_id FOR UPDATE;
 IF NOT FOUND OR current_row.status IS DISTINCT FROM 'suspended' THEN RETURN false; END IF;
 r:=current_row.backend_metadata->'erasure';
 IF r->>'ownerId' IS DISTINCT FROM owner_id OR r->>'attemptId' IS DISTINCT FROM attempt_id THEN RETURN false; END IF;
 IF public.project_grant_release_is_exclusive(owner_id,r->'grantRelease'->>'project') IS DISTINCT FROM true THEN RETURN false; END IF;
 receipt:=public.expected_erasure_bootstrap_release(owner_id,r,recovery_member);
 IF receipt IS NULL THEN RETURN false; END IF;
 IF r ? 'bootstrapGrantRelease' THEN RETURN r->'bootstrapGrantRelease'=receipt; END IF;
 IF r IS DISTINCT FROM expected THEN RETURN false; END IF;
 UPDATE public.personal_agent_registry SET backend_metadata=jsonb_set(backend_metadata,'{erasure,bootstrapGrantRelease}',receipt,true) WHERE user_id=owner_id;
 RETURN true;
END;
$function$
$object$;
 ELSIF encode(sha256(convert_to(actual,'UTF8')),'hex') NOT IN ('dbb4074d095294b94a70a3cedaf36e66faa6280d1ea2bb258e4968828ae8b72b') THEN
  RAISE EXCEPTION 'Unqualified schema drift: reserve_erasure_bootstrap_grants';
 END IF;
END
$object_guard$;

REVOKE ALL ON FUNCTION public."reserve_erasure_bootstrap_grants"(text, text, jsonb, text) FROM PUBLIC;

DO $pod_414$
BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN GRANT EXECUTE ON FUNCTION public."reserve_erasure_bootstrap_grants"(text, text, jsonb, text) TO service_role; END IF;
END
$pod_414$;

DO $object_guard$
DECLARE actual text;
BEGIN
 SELECT definition INTO actual FROM (SELECT pg_get_functiondef(p.oid) definition FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='reserve_erasure_grant_release' AND pg_get_function_identity_arguments(p.oid)='owner_id text, attempt_id text, expected jsonb') observed;
 IF actual IS NULL THEN
  EXECUTE $object$CREATE OR REPLACE FUNCTION public.reserve_erasure_grant_release(owner_id text, attempt_id text, expected jsonb)
 RETURNS boolean
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE current_row public.personal_agent_registry%ROWTYPE; r jsonb; project_id text; receipt jsonb;
BEGIN
 IF current_setting('transaction_isolation') <> 'read committed' THEN RETURN false; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(owner_id,171));
 PERFORM pg_advisory_xact_lock(hashtextextended(owner_id,198));
 SELECT * INTO current_row FROM public.personal_agent_registry WHERE user_id=owner_id FOR UPDATE;
 IF NOT FOUND OR current_row.status IS DISTINCT FROM 'suspended' THEN RETURN false; END IF;
 r:=current_row.backend_metadata->'erasure'; project_id:=r->'registrySnapshot'->>'user_cloud_project';
 receipt:=jsonb_build_object('ownerId',owner_id,'attemptId',attempt_id,'project',project_id,'status','reserved');
 IF public.valid_erasure_grant_release(r,receipt) IS DISTINCT FROM true THEN RETURN false; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(project_id,205));
 IF NOT public.project_grant_release_is_exclusive(owner_id,project_id) THEN RETURN false; END IF;
 IF r ? 'grantRelease' THEN RETURN r->'grantRelease'=receipt; END IF;
 IF r IS DISTINCT FROM expected THEN RETURN false; END IF;
 UPDATE public.personal_agent_registry SET backend_metadata=jsonb_set(backend_metadata,ARRAY['erasure','grantRelease'],receipt,true) WHERE user_id=owner_id;
 RETURN true;
END;
$function$
$object$;
 ELSIF encode(sha256(convert_to(actual,'UTF8')),'hex') NOT IN ('31773f73b7057b12261573a9a42f0c3838046723a49598fad1f3c2dfe92506fc') THEN
  RAISE EXCEPTION 'Unqualified schema drift: reserve_erasure_grant_release';
 END IF;
END
$object_guard$;

REVOKE ALL ON FUNCTION public."reserve_erasure_grant_release"(text, text, jsonb) FROM PUBLIC;

DO $pod_414$
BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN GRANT EXECUTE ON FUNCTION public."reserve_erasure_grant_release"(text, text, jsonb) TO service_role; END IF;
END
$pod_414$;

DO $object_guard$
DECLARE actual text;
BEGIN
 SELECT definition INTO actual FROM (SELECT pg_get_functiondef(p.oid) definition FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='reserve_personal_agent_cloud_removal' AND pg_get_function_identity_arguments(p.oid)='owner_id text, expected_snapshot text') observed;
 IF actual IS NULL THEN
  EXECUTE $object$CREATE OR REPLACE FUNCTION public.reserve_personal_agent_cloud_removal(owner_id text, expected_snapshot text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE agent public.personal_agent_registry%ROWTYPE; r jsonb; snapshot jsonb;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended(owner_id,171));
 PERFORM pg_advisory_xact_lock(hashtextextended(owner_id,198));
 SELECT * INTO agent FROM public.personal_agent_registry WHERE user_id=owner_id FOR UPDATE;
 IF NOT FOUND OR public.personal_agent_cloud_removal_ready() IS NOT TRUE THEN RETURN NULL; END IF;
 snapshot:=coalesce(agent.backend_metadata->'erasure'->'registrySnapshot',to_jsonb(agent));
 IF expected_snapshot IS DISTINCT FROM encode(sha256(convert_to(snapshot::text,'UTF8')),'hex')
 OR snapshot->>'user_id' IS DISTINCT FROM owner_id
 OR EXISTS(SELECT 1 FROM public.personal_agent_standby_placements WHERE user_id=owner_id)
 OR EXISTS(SELECT 1 FROM public.pod_migration_jobs WHERE user_id=owner_id) THEN RETURN NULL; END IF;
 IF snapshot->>'deployment_target'='user_azure' OR public.azure_setup_never_deployed(owner_id,snapshot) IS TRUE THEN
  r:=public.reserve_azure_account_cleanup(owner_id,public.azure_cleanup_candidate_digest(snapshot));
 ELSIF snapshot->>'deployment_target'='user_gcp' THEN
  r:=public.reserve_personal_agent_erasure(owner_id,replace(gen_random_uuid()::text,'-',''));
 ELSE RETURN NULL;
 END IF;
 IF r IS NULL THEN RETURN NULL; END IF;
 INSERT INTO public.personal_agent_cloud_removals(user_id,attempt_id,placement_epoch,snapshot_sha256)
 VALUES(owner_id,r->>'attemptId',agent.placement_epoch,expected_snapshot) ON CONFLICT DO NOTHING;
 RETURN r;
END;
$function$
$object$;
 ELSIF encode(sha256(convert_to(actual,'UTF8')),'hex') NOT IN ('9fafba8d0a010685588103319ddcc2670a5924287e0f2d6dbe92f36f5fbc29f0') THEN
  RAISE EXCEPTION 'Unqualified schema drift: reserve_personal_agent_cloud_removal';
 END IF;
END
$object_guard$;

REVOKE ALL ON FUNCTION public."reserve_personal_agent_cloud_removal"(text, text) FROM PUBLIC;

DO $pod_414$
BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN GRANT EXECUTE ON FUNCTION public."reserve_personal_agent_cloud_removal"(text, text) TO service_role; END IF;
END
$pod_414$;

DO $object_guard$
DECLARE actual text;
BEGIN
 SELECT definition INTO actual FROM (SELECT pg_get_functiondef(p.oid) definition FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='reserve_personal_agent_erasure' AND pg_get_function_identity_arguments(p.oid)='owner_id text, attempt_id text') observed;
 IF actual IS NULL THEN
  EXECUTE $object$CREATE OR REPLACE FUNCTION public.reserve_personal_agent_erasure(owner_id text, attempt_id text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
  current_row public.personal_agent_registry%ROWTYPE;
  reservation jsonb;
BEGIN
  IF owner_id IS NULL OR btrim(owner_id) = '' OR attempt_id IS NULL OR btrim(attempt_id) = '' THEN
    RAISE EXCEPTION 'invalid personal agent erasure admission' USING ERRCODE = '42501';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(owner_id, 171));
  PERFORM pg_advisory_xact_lock(hashtextextended(owner_id, 198));
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgrelid='public.personal_agent_registry'::regclass
      AND tgname='zz_personal_agent_erasure_registry' AND tgenabled IN ('O','A')
      AND tgtype=27 AND tgnargs=0 AND tgqual IS NULL
      AND tgfoid='public.guard_personal_agent_erasure_registry()'::regprocedure
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgrelid='public.consent_audit'::regclass
      AND tgname='zy_personal_agent_erasure_grant' AND tgenabled IN ('O','A')
      AND tgtype=7 AND tgnargs=0 AND tgqual IS NULL
      AND tgfoid='public.guard_personal_agent_erasure_grant()'::regprocedure
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgrelid='public.consent_audit'::regclass
      AND tgname='trg_reject_deleted_account_insert' AND tgenabled IN ('O','A')
      AND tgfoid='public.reject_deleted_account_identity_write()'::regprocedure
  ) THEN
    RAISE EXCEPTION 'personal agent erasure guards unavailable' USING ERRCODE='42501';
  END IF;
  SELECT * INTO current_row FROM public.personal_agent_registry WHERE user_id = owner_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'personal agent erasure registry unavailable' USING ERRCODE = '42501';
  END IF;
  IF current_row.backend_metadata IS NOT NULL AND jsonb_typeof(current_row.backend_metadata) <> 'object' THEN
    RAISE EXCEPTION 'personal agent erasure metadata invalid' USING ERRCODE = '42501';
  END IF;
  IF current_row.backend_metadata ? 'erasure' THEN
    RETURN current_row.backend_metadata->'erasure';
  END IF;
  reservation := jsonb_build_object(
    'version', 1, 'ownerId', owner_id, 'attemptId', attempt_id,
    'hushhId', current_row.hushh_id, 'phase', 'reserved',
    'registrySnapshot', to_jsonb(current_row)
  );
  UPDATE public.personal_agent_registry SET
    backend_metadata = coalesce(backend_metadata, '{}'::jsonb) || jsonb_build_object('erasure', reservation),
    status = 'suspended', updated_at = clock_timestamp()
  WHERE user_id = owner_id;
  RETURN reservation;
END;
$function$
$object$;
 ELSIF encode(sha256(convert_to(actual,'UTF8')),'hex') NOT IN ('cd9672f048b220109cb23cd12e97921f11afddf1616d3bea7fcec10f0eb26195') THEN
  RAISE EXCEPTION 'Unqualified schema drift: reserve_personal_agent_erasure';
 END IF;
END
$object_guard$;

REVOKE ALL ON FUNCTION public."reserve_personal_agent_erasure"(text, text) FROM PUBLIC;

DO $pod_414$
BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN GRANT EXECUTE ON FUNCTION public."reserve_personal_agent_erasure"(text, text) TO service_role; END IF;
END
$pod_414$;

DO $object_guard$
DECLARE actual text;
BEGIN
 SELECT definition INTO actual FROM (SELECT pg_get_functiondef(p.oid) definition FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='restore_personal_agent_erasure_reservation' AND pg_get_function_identity_arguments(p.oid)='owner_id text, attempt_id text, snapshot_sha256 text, evidence jsonb') observed;
 IF actual IS NULL THEN
  EXECUTE $object$CREATE OR REPLACE FUNCTION public.restore_personal_agent_erasure_reservation(owner_id text, attempt_id text, snapshot_sha256 text, evidence jsonb)
 RETURNS boolean
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
  current_row public.personal_agent_registry%ROWTYPE;
  reservation jsonb;
  snapshot jsonb;
  restored public.personal_agent_registry%ROWTYPE;
BEGIN
  IF current_setting('transaction_isolation') NOT IN ('read committed','read uncommitted') THEN RETURN false; END IF;
  IF owner_id IS NULL OR btrim(owner_id) = ''
     OR attempt_id IS NULL OR attempt_id !~ '^[a-f0-9]{32}$'
     OR snapshot_sha256 IS NULL OR snapshot_sha256 !~ '^[a-f0-9]{64}$'
     OR jsonb_typeof(evidence) IS DISTINCT FROM 'object'
     OR evidence - ARRAY['project','service','url','observedAt'] <> '{}'::jsonb
     OR length(evidence->>'project') = 0 OR length(evidence->>'service') = 0 THEN
    RETURN false;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(owner_id, 171));
  PERFORM pg_advisory_xact_lock(hashtextextended(owner_id, 198));
  SELECT * INTO current_row
  FROM public.personal_agent_registry
  WHERE user_id = owner_id
  FOR UPDATE;
  IF NOT FOUND OR current_row.status IS DISTINCT FROM 'suspended' THEN RETURN false; END IF;

  reservation := current_row.backend_metadata->'erasure';
  snapshot := reservation->'registrySnapshot';
  IF reservation IS NULL
     OR reservation - ARRAY['version','ownerId','attemptId','hushhId','phase','registrySnapshot'] <> '{}'::jsonb
     OR reservation->>'ownerId' IS DISTINCT FROM owner_id
     OR reservation->>'attemptId' IS DISTINCT FROM attempt_id
     OR reservation->>'phase' IS DISTINCT FROM 'reserved'
     OR snapshot->>'status' IS DISTINCT FROM 'provisioned'
     OR jsonb_typeof(snapshot->'backend_metadata') IS DISTINCT FROM 'object'
     OR snapshot->'backend_metadata' ? 'erasure'
     OR encode(sha256(convert_to(snapshot::text, 'UTF8')), 'hex') IS DISTINCT FROM snapshot_sha256
     OR evidence->>'project' IS DISTINCT FROM coalesce(snapshot->>'user_cloud_project', snapshot->'backend_metadata'->>'project')
     OR evidence->>'service' IS DISTINCT FROM coalesce(snapshot->>'external_agent_id', snapshot->'backend_metadata'->>'service')
     OR (snapshot->'backend_metadata'->>'url' IS NOT NULL
         AND evidence->>'url' IS DISTINCT FROM snapshot->'backend_metadata'->>'url') THEN
    RETURN false;
  END IF;
  -- A deletion tombstone or account-erasure tombstone always wins. This function
  -- cannot resurrect an identity that the erasure workflow has completed or begun.
  IF EXISTS (
    SELECT 1 FROM public.personal_agent_deletion_tombstones
    WHERE hushh_id = current_row.hushh_id
  ) OR EXISTS (
    SELECT 1 FROM public.account_deletion_tombstones
    WHERE user_id_hash = 'sha256:' || encode(sha256(convert_to(owner_id, 'UTF8')), 'hex')
  ) OR NOT EXISTS (
    SELECT 1 FROM public.byoc_setup_jobs
    WHERE user_id = owner_id AND status = 'recorded' AND authorization_attempts = '{}'::jsonb
  ) THEN
    RETURN false;
  END IF;

  restored := jsonb_populate_record(NULL::public.personal_agent_registry, snapshot);
  PERFORM set_config('hussh.erasure_restore_attempt', attempt_id, true);
  UPDATE public.personal_agent_registry SET
    hushh_id = restored.hushh_id,
    phone_e164_hash = restored.phone_e164_hash,
    space_id = restored.space_id,
    backend = restored.backend,
    external_agent_id = restored.external_agent_id,
    a2a_route = restored.a2a_route,
    backend_metadata = restored.backend_metadata,
    attestation_ref = restored.attestation_ref,
    pod_pubkey = restored.pod_pubkey,
    pod_key_id = restored.pod_key_id,
    pod_key_wrapping_alg = restored.pod_key_wrapping_alg,
    runtime_version = restored.runtime_version,
    prompt_version = restored.prompt_version,
    status = restored.status,
    region = restored.region,
    provisioned_at = restored.provisioned_at,
    created_at = restored.created_at,
    last_heartbeat_at = restored.last_heartbeat_at,
    health_state = restored.health_state,
    liveness_mode = restored.liveness_mode,
    last_probe_at = restored.last_probe_at,
    liveness_failures = restored.liveness_failures,
    last_healed_at = restored.last_healed_at,
    deployment_target = restored.deployment_target,
    model_credential_mode = restored.model_credential_mode,
    user_cloud_project = restored.user_cloud_project,
    user_cloud_region = restored.user_cloud_region,
    user_cloud_bootstrap_sa = restored.user_cloud_bootstrap_sa,
    user_cloud_authorized_at = restored.user_cloud_authorized_at,
    billing_space_id = restored.billing_space_id,
    updated_at = clock_timestamp()
  WHERE user_id = owner_id;
  RETURN FOUND;
END;
$function$
$object$;
 ELSIF encode(sha256(convert_to(actual,'UTF8')),'hex') NOT IN ('ee9edcab13062929c3cd0b97cc7d26984226998a5158b55822b47496933f0494','11d4bd2dbadaf0b690563223a81db6295db193f7a7ae47a78eefef9c129a2a6e') THEN
  RAISE EXCEPTION 'Unqualified schema drift: restore_personal_agent_erasure_reservation';
 END IF;
END
$object_guard$;

REVOKE ALL ON FUNCTION public."restore_personal_agent_erasure_reservation"(text, text, text, jsonb) FROM PUBLIC;

DO $pod_414$
BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN GRANT EXECUTE ON FUNCTION public."restore_personal_agent_erasure_reservation"(text, text, text, jsonb) TO service_role; END IF;
END
$pod_414$;

DO $object_guard$
DECLARE actual text;
BEGIN
 SELECT definition INTO actual FROM (SELECT pg_get_functiondef(p.oid) definition FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='retain_azure_cleanup_authorization_outcome' AND pg_get_function_identity_arguments(p.oid)='owner_id text, attempt_id text, nonce_sha256 text, purpose text, auth_digest text, outcome text, code text') observed;
 IF actual IS NULL THEN
  EXECUTE $object$CREATE OR REPLACE FUNCTION public.retain_azure_cleanup_authorization_outcome(owner_id text, attempt_id text, nonce_sha256 text, purpose text, auth_digest text, outcome text, code text)
 RETURNS boolean
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE r jsonb; state jsonb; incoming jsonb; now_seconds bigint:=extract(epoch FROM statement_timestamp())::bigint;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended(owner_id,171));
 PERFORM pg_advisory_xact_lock(hashtextextended(owner_id,198));
 SELECT backend_metadata->'erasure' INTO r FROM public.personal_agent_registry
 WHERE user_id=owner_id AND status='suspended' FOR UPDATE;
 IF r->>'attemptId' IS DISTINCT FROM attempt_id THEN RETURN false; END IF;
 state:=r->'azureTeardown';
 incoming:=state->'authorizationAttempts'->nonce_sha256;
 IF outcome='running' THEN
  incoming:=jsonb_build_object('purpose',purpose,'digest',auth_digest,'status','running','startedAt',now_seconds);
 ELSE
  IF incoming->>'purpose' IS DISTINCT FROM purpose OR incoming->>'digest' IS DISTINCT FROM auth_digest THEN RETURN false; END IF;
  incoming:=incoming||jsonb_build_object('status',outcome,'finishedAt',now_seconds,'code',code);
 END IF;
 state:=jsonb_set(state,'{authorizationAttempts}',coalesce(state->'authorizationAttempts','{}'::jsonb)||jsonb_build_object(nonce_sha256,incoming));
 RETURN public.retain_azure_erasure_state(owner_id,attempt_id,r,state);
END;
$function$
$object$;
 ELSIF encode(sha256(convert_to(actual,'UTF8')),'hex') NOT IN ('e4d22361c9f31994214529a066aab4de988f49d46f02890c89f01976e776ef00') THEN
  RAISE EXCEPTION 'Unqualified schema drift: retain_azure_cleanup_authorization_outcome';
 END IF;
END
$object_guard$;

REVOKE ALL ON FUNCTION public."retain_azure_cleanup_authorization_outcome"(text, text, text, text, text, text, text) FROM PUBLIC;

DO $pod_414$
BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN GRANT EXECUTE ON FUNCTION public."retain_azure_cleanup_authorization_outcome"(text, text, text, text, text, text, text) TO service_role; END IF;
END
$pod_414$;

DO $object_guard$
DECLARE actual text;
BEGIN
 SELECT definition INTO actual FROM (SELECT pg_get_functiondef(p.oid) definition FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='retain_azure_erasure_execution_receipt' AND pg_get_function_identity_arguments(p.oid)='owner_id text, attempt_id text, execution_id text, stage text, outcome text, observed_ids jsonb') observed;
 IF actual IS NULL THEN
  EXECUTE $object$CREATE OR REPLACE FUNCTION public.retain_azure_erasure_execution_receipt(owner_id text, attempt_id text, execution_id text, stage text, outcome text, observed_ids jsonb)
 RETURNS boolean
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE r jsonb; state jsonb; receipt jsonb; ids jsonb;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended(owner_id,171));
 PERFORM pg_advisory_xact_lock(hashtextextended(owner_id,198));
 SELECT backend_metadata->'erasure' INTO r FROM public.personal_agent_registry
 WHERE user_id=owner_id AND status='suspended' FOR UPDATE;
 state:=r->'azureTeardown';
 IF r->>'attemptId' IS DISTINCT FROM attempt_id
 OR state->'worker'->>'executionId' IS DISTINCT FROM execution_id
 OR public.byoc_azure_worker_session_held(owner_id) IS NOT TRUE
 OR state->'worker'->'backendPid' IS DISTINCT FROM to_jsonb(pg_backend_pid())
 OR (stage IN ('finalReadbacks','workerExits')) IS NOT TRUE THEN RETURN false; END IF;
 IF stage='finalReadbacks' THEN
  IF jsonb_typeof(observed_ids) IS DISTINCT FROM 'array' THEN RETURN false; END IF;
  IF jsonb_array_length(observed_ids) NOT BETWEEN 1 AND 128 THEN RETURN false; END IF;
  SELECT jsonb_agg(value ORDER BY value) INTO ids FROM jsonb_array_elements_text(observed_ids);
  IF ids IS DISTINCT FROM (SELECT jsonb_agg(key ORDER BY key)
   FROM jsonb_each(state->'plan'->'resources') WHERE value->'coveredBy'='null'::jsonb)
  THEN RETURN false; END IF;
 ELSIF observed_ids IS NOT NULL THEN RETURN false; END IF;
 receipt:=public.azure_erasure_execution_receipt(state,stage,outcome);
 IF receipt IS NULL THEN RETURN false; END IF;
 state:=jsonb_set(state,ARRAY[stage],coalesce(state->stage,'{}'::jsonb)||
   jsonb_build_object(execution_id,receipt));
 RETURN public.retain_azure_erasure_state(owner_id,attempt_id,r,state);
END;
$function$
$object$;
 ELSIF encode(sha256(convert_to(actual,'UTF8')),'hex') NOT IN ('8d0f917f2835ef3c4082908ed8028c9f068895afbdd733faf71417b84a5d8661') THEN
  RAISE EXCEPTION 'Unqualified schema drift: retain_azure_erasure_execution_receipt';
 END IF;
END
$object_guard$;

REVOKE ALL ON FUNCTION public."retain_azure_erasure_execution_receipt"(text, text, text, text, text, jsonb) FROM PUBLIC;

DO $pod_414$
BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN GRANT EXECUTE ON FUNCTION public."retain_azure_erasure_execution_receipt"(text, text, text, text, text, jsonb) TO service_role; END IF;
END
$pod_414$;

DO $object_guard$
DECLARE actual text;
BEGIN
 SELECT definition INTO actual FROM (SELECT pg_get_functiondef(p.oid) definition FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='retain_azure_erasure_state' AND pg_get_function_identity_arguments(p.oid)='owner_id text, attempt_id text, expected jsonb, next_state jsonb') observed;
 IF actual IS NULL THEN
  EXECUTE $object$CREATE OR REPLACE FUNCTION public.retain_azure_erasure_state(owner_id text, attempt_id text, expected jsonb, next_state jsonb)
 RETURNS boolean
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE agent public.personal_agent_registry%ROWTYPE; r jsonb; candidate jsonb;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended(owner_id,171));
 PERFORM pg_advisory_xact_lock(hashtextextended(owner_id,198));
 SELECT * INTO agent FROM public.personal_agent_registry WHERE user_id=owner_id FOR UPDATE;
 IF NOT FOUND OR agent.status IS DISTINCT FROM 'suspended' THEN RETURN false; END IF;
 r:=agent.backend_metadata->'erasure';
 IF r->>'ownerId' IS DISTINCT FROM owner_id OR r->>'attemptId' IS DISTINCT FROM attempt_id THEN RETURN false; END IF;
 IF r->'azureTeardown'=next_state THEN RETURN true; END IF;
 IF r IS DISTINCT FROM expected THEN RETURN false; END IF;
 candidate:=r||jsonb_build_object('azureTeardown',next_state);
 IF public.valid_azure_erasure_append(owner_id,r,candidate) IS NOT TRUE THEN RETURN false; END IF;
 UPDATE public.personal_agent_registry SET backend_metadata=jsonb_set(backend_metadata,'{erasure}',candidate)
 WHERE user_id=owner_id;
 RETURN FOUND;
END;
$function$
$object$;
 ELSIF encode(sha256(convert_to(actual,'UTF8')),'hex') NOT IN ('dd59de662df8f20e5c3d2509f005464d86af23f3f59c189039e314a6ac03f16a') THEN
  RAISE EXCEPTION 'Unqualified schema drift: retain_azure_erasure_state';
 END IF;
END
$object_guard$;

REVOKE ALL ON FUNCTION public."retain_azure_erasure_state"(text, text, jsonb, jsonb) FROM PUBLIC;

DO $pod_414$
BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN GRANT EXECUTE ON FUNCTION public."retain_azure_erasure_state"(text, text, jsonb, jsonb) TO service_role; END IF;
END
$pod_414$;

DO $object_guard$
DECLARE actual text;
BEGIN
 SELECT definition INTO actual FROM (SELECT pg_get_functiondef(p.oid) definition FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='retain_byoc_authorization' AND pg_get_function_identity_arguments(p.oid)='owner_id text, target_job text, intent jsonb, receipt jsonb') observed;
 IF actual IS NULL THEN
  EXECUTE $object$CREATE OR REPLACE FUNCTION public.retain_byoc_authorization(owner_id text, target_job text, intent jsonb, receipt jsonb DEFAULT NULL::jsonb)
 RETURNS boolean
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE current_row public.byoc_setup_jobs%ROWTYPE; old_v jsonb; new_v jsonb;
BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid='public.byoc_setup_jobs'::regclass AND tgname='zz_byoc_authorization_attempts' AND tgfoid='public.guard_byoc_authorization_attempts()'::regprocedure AND tgtype=31 AND tgenabled IN ('O','A') AND tgnargs=0 AND tgqual IS NULL) THEN RETURN false; END IF;
 SELECT * INTO current_row FROM public.byoc_setup_jobs WHERE user_id=owner_id FOR UPDATE;
 IF NOT FOUND THEN RETURN false; END IF;
 old_v:=current_row.authorization_attempts->target_job;
 new_v:=jsonb_build_object('intent',intent);
 IF receipt IS NOT NULL THEN
  IF old_v IS NULL OR old_v->'intent' IS DISTINCT FROM intent THEN RETURN false; END IF;
  new_v:=new_v||jsonb_build_object('receipt',receipt);
 END IF;
 IF receipt IS NULL AND old_v IS NOT NULL THEN RETURN false; END IF;
 IF old_v=new_v THEN RETURN true; END IF;
 UPDATE public.byoc_setup_jobs SET authorization_attempts=jsonb_set(authorization_attempts,ARRAY[target_job],new_v,true) WHERE user_id=owner_id;
 RETURN true;
END;
$function$
$object$;
 ELSIF encode(sha256(convert_to(actual,'UTF8')),'hex') NOT IN ('210463d6e1f773ab6e410f7cef93ca76103ad7a70a973b5d3846f8de9fdc1640') THEN
  RAISE EXCEPTION 'Unqualified schema drift: retain_byoc_authorization';
 END IF;
END
$object_guard$;

REVOKE ALL ON FUNCTION public."retain_byoc_authorization"(text, text, jsonb, jsonb) FROM PUBLIC;

DO $pod_414$
BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN GRANT EXECUTE ON FUNCTION public."retain_byoc_authorization"(text, text, jsonb, jsonb) TO service_role; END IF;
END
$pod_414$;

DO $object_guard$
DECLARE actual text;
BEGIN
 SELECT definition INTO actual FROM (SELECT pg_get_functiondef(p.oid) definition FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='retain_byoc_azure_setup_intent' AND pg_get_function_identity_arguments(p.oid)='owner_id text, expected_job text, intent jsonb') observed;
 IF actual IS NULL THEN
  EXECUTE $object$CREATE OR REPLACE FUNCTION public.retain_byoc_azure_setup_intent(owner_id text, expected_job text, intent jsonb)
 RETURNS boolean
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE agent public.personal_agent_registry%ROWTYPE;
 job public.byoc_setup_jobs%ROWTYPE; previous jsonb; matches integer;
BEGIN
 IF public.byoc_azure_setup_guards_ready() IS NOT TRUE THEN RETURN false; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(owner_id,171));
 PERFORM pg_advisory_xact_lock(hashtextextended(owner_id,198));
 SELECT * INTO agent FROM public.personal_agent_registry WHERE user_id=owner_id FOR UPDATE;
 IF NOT FOUND THEN RETURN false; END IF;
 SELECT * INTO job FROM public.byoc_setup_jobs WHERE user_id=owner_id FOR UPDATE;
 IF NOT FOUND OR job.job_id IS DISTINCT FROM expected_job OR job.status <> 'running'
    OR jsonb_typeof(job.stages) IS DISTINCT FROM 'array'
    OR public.valid_byoc_azure_setup_intent(owner_id,expected_job,job.project_id,
      agent.hushh_id,intent) IS NOT TRUE
    OR public.byoc_azure_intent_admitted(agent,job,intent) IS NOT TRUE THEN RETURN false; END IF;
 PERFORM public.assert_project_grant_admission(job.project_id);
 SELECT count(*), (jsonb_agg(s->'intent'))->0 INTO matches, previous
   FROM jsonb_array_elements(job.stages) s WHERE s->>'stage'='azure_setup_intent';
 IF matches > 0 THEN RETURN matches=1 AND previous=intent; END IF;
 IF jsonb_array_length(job.stages) >= 2048 OR (SELECT count(*)
   FROM jsonb_array_elements(job.stages) x
   WHERE x->>'stage' IN ('azure_setup_intent','azure_setup_prior_intent')) >= 64
 THEN RETURN false; END IF;
 UPDATE public.byoc_setup_jobs SET stages=stages || jsonb_build_array(
   jsonb_build_object('stage','azure_setup_intent','intent',intent)), updated_at=now()
 WHERE user_id=owner_id AND job_id=expected_job AND status='running';
 RETURN FOUND;
END;
$function$
$object$;
 ELSIF encode(sha256(convert_to(actual,'UTF8')),'hex') NOT IN ('6dc5843f1a388f39848d15fbcdee123adc5ac9b33c3573adbd95c23bec18ea51') THEN
  RAISE EXCEPTION 'Unqualified schema drift: retain_byoc_azure_setup_intent';
 END IF;
END
$object_guard$;

REVOKE ALL ON FUNCTION public."retain_byoc_azure_setup_intent"(text, text, jsonb) FROM PUBLIC;

DO $pod_414$
BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN GRANT EXECUTE ON FUNCTION public."retain_byoc_azure_setup_intent"(text, text, jsonb) TO service_role; END IF;
END
$pod_414$;

DO $object_guard$
DECLARE actual text;
BEGIN
 SELECT definition INTO actual FROM (SELECT pg_get_functiondef(p.oid) definition FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='retain_byoc_azure_worker_event' AND pg_get_function_identity_arguments(p.oid)='owner_id text, expected_job text, event jsonb') observed;
 IF actual IS NULL THEN
  EXECUTE $object$CREATE OR REPLACE FUNCTION public.retain_byoc_azure_worker_event(owner_id text, expected_job text, event jsonb)
 RETURNS boolean
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE agent public.personal_agent_registry%ROWTYPE; job public.byoc_setup_jobs%ROWTYPE;
BEGIN
 IF public.byoc_azure_setup_guards_ready() IS NOT TRUE THEN RETURN false; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(owner_id,171));
 PERFORM pg_advisory_xact_lock(hashtextextended(owner_id,198));
 SELECT * INTO agent FROM public.personal_agent_registry WHERE user_id=owner_id FOR UPDATE;
 IF NOT FOUND THEN RETURN false; END IF;
 SELECT * INTO job FROM public.byoc_setup_jobs WHERE user_id=owner_id FOR UPDATE;
 IF NOT FOUND OR job.job_id IS DISTINCT FROM expected_job
 OR jsonb_typeof(job.stages) IS DISTINCT FROM 'array' THEN RETURN false; END IF;
 IF EXISTS (SELECT 1 FROM jsonb_array_elements(job.stages) x WHERE x=event) THEN RETURN true; END IF;
 IF event->>'stage' IN ('azure_worker_started','azure_provider_request') AND
   public.byoc_azure_live_worker_admitted(owner_id,expected_job,event->>'stage'='azure_worker_started') IS NOT TRUE
 THEN RETURN false; END IF;
 IF public.byoc_azure_worker_history_has_capacity(job.stages||jsonb_build_array(event)) IS NOT TRUE
 THEN RETURN false; END IF;
 IF public.valid_byoc_azure_worker_event(owner_id,expected_job,event,job.stages,
    job.project_id,agent.hushh_id) IS NOT TRUE THEN RETURN false; END IF;
 UPDATE public.byoc_setup_jobs SET stages=stages||jsonb_build_array(event),updated_at=now()
 WHERE user_id=owner_id AND job_id=expected_job;
 RETURN FOUND;
END;
$function$
$object$;
 ELSIF encode(sha256(convert_to(actual,'UTF8')),'hex') NOT IN ('3d379e569af6d7fbc4f90b27066cb7143960479fd0b5bb1e1c3974822496eeab') THEN
  RAISE EXCEPTION 'Unqualified schema drift: retain_byoc_azure_worker_event';
 END IF;
END
$object_guard$;

REVOKE ALL ON FUNCTION public."retain_byoc_azure_worker_event"(text, text, jsonb) FROM PUBLIC;

DO $pod_414$
BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN GRANT EXECUTE ON FUNCTION public."retain_byoc_azure_worker_event"(text, text, jsonb) TO service_role; END IF;
END
$pod_414$;

DO $object_guard$
DECLARE actual text;
BEGIN
 SELECT definition INTO actual FROM (SELECT pg_get_functiondef(p.oid) definition FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='retain_erasure_account_receipt' AND pg_get_function_identity_arguments(p.oid)='owner_id text, attempt_id text, expected jsonb, stage text, receipt jsonb') observed;
 IF actual IS NULL THEN
  EXECUTE $object$CREATE OR REPLACE FUNCTION public.retain_erasure_account_receipt(owner_id text, attempt_id text, expected jsonb, stage text, receipt jsonb)
 RETURNS boolean
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE current_row public.personal_agent_registry%ROWTYPE; r jsonb; s jsonb;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended(owner_id,171));
 PERFORM pg_advisory_xact_lock(hashtextextended(owner_id,198));
 SELECT * INTO current_row FROM public.personal_agent_registry WHERE user_id=owner_id FOR UPDATE;
 IF NOT FOUND OR current_row.status IS DISTINCT FROM 'suspended' THEN RETURN false; END IF;
 r:=current_row.backend_metadata->'erasure';
 IF r->>'ownerId' IS DISTINCT FROM owner_id OR r->>'attemptId' IS DISTINCT FROM attempt_id
 OR public.valid_erasure_account_receipt(r,stage,receipt) IS DISTINCT FROM true THEN RETURN false; END IF;
 IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid='public.personal_agent_registry'::regclass
 AND tgname='zz_personal_agent_erasure_registry' AND tgenabled IN ('O','A') AND tgtype=27 AND tgnargs=0 AND tgqual IS NULL
 AND tgfoid='public.guard_personal_agent_erasure_registry()'::regprocedure) THEN RETURN false; END IF;
 s:=coalesce(r->'accountErasure','{}'::jsonb);
 IF s ? stage THEN RETURN stage <> 'admission' AND s->stage=receipt; END IF;
 IF r IS DISTINCT FROM expected THEN RETURN false; END IF;
 UPDATE public.personal_agent_registry SET backend_metadata=jsonb_set(backend_metadata,ARRAY['erasure','accountErasure'],s || jsonb_build_object(stage,receipt),true) WHERE user_id=owner_id;
 RETURN true;
END;
$function$
$object$;
 ELSIF encode(sha256(convert_to(actual,'UTF8')),'hex') NOT IN ('4192d725f0e8a0bb924d636332a8da7a32bc4d06fd492c135b1c70df1f980d36') THEN
  RAISE EXCEPTION 'Unqualified schema drift: retain_erasure_account_receipt';
 END IF;
END
$object_guard$;

REVOKE ALL ON FUNCTION public."retain_erasure_account_receipt"(text, text, jsonb, text, jsonb) FROM PUBLIC;

DO $pod_414$
BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN GRANT EXECUTE ON FUNCTION public."retain_erasure_account_receipt"(text, text, jsonb, text, jsonb) TO service_role; END IF;
END
$pod_414$;

DO $object_guard$
DECLARE actual text;
BEGIN
 SELECT definition INTO actual FROM (SELECT pg_get_functiondef(p.oid) definition FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='retain_erasure_bootstrap_grant_receipt' AND pg_get_function_identity_arguments(p.oid)='owner_id text, attempt_id text, expected jsonb, grant_key text, stage text, receipt jsonb') observed;
 IF actual IS NULL THEN
  EXECUTE $object$CREATE OR REPLACE FUNCTION public.retain_erasure_bootstrap_grant_receipt(owner_id text, attempt_id text, expected jsonb, grant_key text, stage text, receipt jsonb)
 RETURNS boolean
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE current_row public.personal_agent_registry%ROWTYPE; r jsonb; candidate jsonb; groups jsonb; stages jsonb;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended(owner_id,171));
 PERFORM pg_advisory_xact_lock(hashtextextended(owner_id,198));
 SELECT * INTO current_row FROM public.personal_agent_registry WHERE user_id=owner_id FOR UPDATE;
 IF NOT FOUND OR current_row.status IS DISTINCT FROM 'suspended' THEN RETURN false; END IF;
 r:=current_row.backend_metadata->'erasure';
 IF r->>'ownerId' IS DISTINCT FROM owner_id OR r->>'attemptId' IS DISTINCT FROM attempt_id THEN RETURN false; END IF;
 IF public.project_grant_release_is_exclusive(owner_id,r->'grantRelease'->>'project') IS DISTINCT FROM true THEN RETURN false; END IF;
 IF stage IS NULL OR stage NOT IN ('admission','acknowledgement','deletion') OR grant_key IS NULL OR NOT (r->'bootstrapGrantRelease'->'groups' ? grant_key) THEN RETURN false; END IF;
 IF r->'bootstrapGrantErasure'->grant_key ? stage THEN RETURN stage<>'admission' AND r->'bootstrapGrantErasure'->grant_key->stage=receipt; END IF;
 IF r IS DISTINCT FROM expected THEN RETURN false; END IF;
 groups:=coalesce(r->'bootstrapGrantErasure','{}'::jsonb); stages:=coalesce(groups->grant_key,'{}'::jsonb);
 stages:=jsonb_set(stages,ARRAY[stage],receipt,true); groups:=jsonb_set(groups,ARRAY[grant_key],stages,true);
 candidate:=jsonb_set(r,'{bootstrapGrantErasure}',groups,true);
 IF public.valid_erasure_bootstrap_append(r,candidate) IS DISTINCT FROM true THEN RETURN false; END IF;
 UPDATE public.personal_agent_registry SET backend_metadata=jsonb_set(backend_metadata,'{erasure}',candidate,true) WHERE user_id=owner_id;
 RETURN true;
END;
$function$
$object$;
 ELSIF encode(sha256(convert_to(actual,'UTF8')),'hex') NOT IN ('743badf313fe71b200557379ea7966fda8cebdb3c94d29cad239f85cf9c1b344') THEN
  RAISE EXCEPTION 'Unqualified schema drift: retain_erasure_bootstrap_grant_receipt';
 END IF;
END
$object_guard$;

REVOKE ALL ON FUNCTION public."retain_erasure_bootstrap_grant_receipt"(text, text, jsonb, text, text, jsonb) FROM PUBLIC;

DO $pod_414$
BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN GRANT EXECUTE ON FUNCTION public."retain_erasure_bootstrap_grant_receipt"(text, text, jsonb, text, text, jsonb) TO service_role; END IF;
END
$pod_414$;

DO $object_guard$
DECLARE actual text;
BEGIN
 SELECT definition INTO actual FROM (SELECT pg_get_functiondef(p.oid) definition FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='retain_erasure_bucket_receipt' AND pg_get_function_identity_arguments(p.oid)='owner_id text, attempt_id text, expected jsonb, stage text, receipt jsonb') observed;
 IF actual IS NULL THEN
  EXECUTE $object$CREATE OR REPLACE FUNCTION public.retain_erasure_bucket_receipt(owner_id text, attempt_id text, expected jsonb, stage text, receipt jsonb)
 RETURNS boolean
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE current_row public.personal_agent_registry%ROWTYPE; reservation jsonb;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended(owner_id,171));
 PERFORM pg_advisory_xact_lock(hashtextextended(owner_id,198));
 SELECT * INTO current_row FROM public.personal_agent_registry WHERE user_id=owner_id FOR UPDATE;
 IF NOT FOUND OR current_row.status IS DISTINCT FROM 'suspended' THEN RETURN false; END IF;
 reservation := current_row.backend_metadata->'erasure';
 IF reservation->>'ownerId' IS DISTINCT FROM owner_id OR reservation->>'attemptId' IS DISTINCT FROM attempt_id
    OR public.valid_erasure_bucket_receipt(reservation,stage,receipt) IS DISTINCT FROM true THEN RETURN false; END IF;
 IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid='public.personal_agent_registry'::regclass
    AND tgname='zz_personal_agent_erasure_registry' AND tgenabled IN ('O','A')
    AND tgtype=27 AND tgnargs=0 AND tgqual IS NULL
    AND tgfoid='public.guard_personal_agent_erasure_registry()'::regprocedure) THEN RETURN false; END IF;
 IF reservation ? stage THEN
   RETURN stage <> 'bucketAdmission' AND reservation->stage=receipt;
 END IF;
 IF reservation IS DISTINCT FROM expected THEN RETURN false; END IF;
 UPDATE public.personal_agent_registry SET backend_metadata=jsonb_set(backend_metadata,ARRAY['erasure',stage],receipt,true)
 WHERE user_id=owner_id;
 RETURN true;
END;
$function$
$object$;
 ELSIF encode(sha256(convert_to(actual,'UTF8')),'hex') NOT IN ('de603794bd51f3002d2d953151f6fbafd982d06faf2adbfc08d92b87672bf2b6') THEN
  RAISE EXCEPTION 'Unqualified schema drift: retain_erasure_bucket_receipt';
 END IF;
END
$object_guard$;

REVOKE ALL ON FUNCTION public."retain_erasure_bucket_receipt"(text, text, jsonb, text, jsonb) FROM PUBLIC;

DO $pod_414$
BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN GRANT EXECUTE ON FUNCTION public."retain_erasure_bucket_receipt"(text, text, jsonb, text, jsonb) TO service_role; END IF;
END
$pod_414$;

DO $object_guard$
DECLARE actual text;
BEGIN
 SELECT definition INTO actual FROM (SELECT pg_get_functiondef(p.oid) definition FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='retain_erasure_compute_receipt' AND pg_get_function_identity_arguments(p.oid)='owner_id text, attempt_id text, expected jsonb, stage text, receipt jsonb') observed;
 IF actual IS NULL THEN
  EXECUTE $object$CREATE OR REPLACE FUNCTION public.retain_erasure_compute_receipt(owner_id text, attempt_id text, expected jsonb, stage text, receipt jsonb)
 RETURNS boolean
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE current_row public.personal_agent_registry%ROWTYPE; reservation jsonb;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended(owner_id,171));
 PERFORM pg_advisory_xact_lock(hashtextextended(owner_id,198));
 SELECT * INTO current_row FROM public.personal_agent_registry WHERE user_id=owner_id FOR UPDATE;
 IF NOT FOUND OR current_row.status IS DISTINCT FROM 'suspended' THEN RETURN false; END IF;
 reservation := current_row.backend_metadata->'erasure';
 IF reservation->>'ownerId' IS DISTINCT FROM owner_id
    OR reservation->>'attemptId' IS DISTINCT FROM attempt_id
    OR NOT public.valid_erasure_compute_receipt(reservation,stage,receipt) THEN RETURN false; END IF;
 IF NOT EXISTS (SELECT 1 FROM pg_trigger
    WHERE tgrelid='public.personal_agent_registry'::regclass
      AND tgname='zz_personal_agent_erasure_registry' AND tgenabled IN ('O','A')
      AND tgtype=27 AND tgnargs=0 AND tgqual IS NULL
      AND tgfoid='public.guard_personal_agent_erasure_registry()'::regprocedure) THEN RETURN false; END IF;
 -- A repeated admission is observation of an uncertain prior DELETE, not a lease.
 IF reservation ? stage THEN
   RETURN stage <> 'computeAdmission' AND reservation->stage=receipt;
 END IF;
 IF reservation IS DISTINCT FROM expected THEN RETURN false; END IF;
 UPDATE public.personal_agent_registry SET backend_metadata=jsonb_set(
    backend_metadata,ARRAY['erasure',stage],receipt,true) WHERE user_id=owner_id;
 RETURN true;
END;
$function$
$object$;
 ELSIF encode(sha256(convert_to(actual,'UTF8')),'hex') NOT IN ('a0ec52cb6615b28c891dd8e3d9a22ea619bc143bf478603892bd289f02791998') THEN
  RAISE EXCEPTION 'Unqualified schema drift: retain_erasure_compute_receipt';
 END IF;
END
$object_guard$;

REVOKE ALL ON FUNCTION public."retain_erasure_compute_receipt"(text, text, jsonb, text, jsonb) FROM PUBLIC;

DO $pod_414$
BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN GRANT EXECUTE ON FUNCTION public."retain_erasure_compute_receipt"(text, text, jsonb, text, jsonb) TO service_role; END IF;
END
$pod_414$;

DO $object_guard$
DECLARE actual text;
BEGIN
 SELECT definition INTO actual FROM (SELECT pg_get_functiondef(p.oid) definition FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='retain_erasure_files_receipt' AND pg_get_function_identity_arguments(p.oid)='owner_id text, attempt_id text, expected jsonb, kind text, stage text, receipt jsonb') observed;
 IF actual IS NULL THEN
  EXECUTE $object$CREATE OR REPLACE FUNCTION public.retain_erasure_files_receipt(owner_id text, attempt_id text, expected jsonb, kind text, stage text, receipt jsonb)
 RETURNS boolean
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE current_row public.personal_agent_registry%ROWTYPE; reservation jsonb;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended(owner_id,171));
 PERFORM pg_advisory_xact_lock(hashtextextended(owner_id,198));
 SELECT * INTO current_row FROM public.personal_agent_registry WHERE user_id=owner_id FOR UPDATE;
 IF NOT FOUND OR current_row.status IS DISTINCT FROM 'suspended' THEN RETURN false; END IF;
 reservation := current_row.backend_metadata->'erasure';
 IF reservation->>'ownerId' IS DISTINCT FROM owner_id OR reservation->>'attemptId' IS DISTINCT FROM attempt_id
    OR public.valid_erasure_files_receipt(reservation,kind,stage,receipt) IS DISTINCT FROM true THEN RETURN false; END IF;
 IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid='public.personal_agent_registry'::regclass
    AND tgname='zz_personal_agent_erasure_registry' AND tgenabled IN ('O','A')
    AND tgtype=27 AND tgnargs=0 AND tgqual IS NULL
    AND tgfoid='public.guard_personal_agent_erasure_registry()'::regprocedure) THEN RETURN false; END IF;
 IF reservation->'filesErasure'->kind ? stage THEN
   RETURN stage <> 'admission' AND reservation->'filesErasure'->kind->stage=receipt;
 END IF;
 IF reservation IS DISTINCT FROM expected THEN RETURN false; END IF;
 UPDATE public.personal_agent_registry SET backend_metadata=jsonb_set(backend_metadata,ARRAY['erasure','filesErasure'],coalesce(reservation->'filesErasure','{}'::jsonb) || jsonb_build_object(kind,coalesce(reservation->'filesErasure'->kind,'{}'::jsonb) || jsonb_build_object(stage,receipt)),true)
 WHERE user_id=owner_id;
 RETURN true;
END;
$function$
$object$;
 ELSIF encode(sha256(convert_to(actual,'UTF8')),'hex') NOT IN ('5605bccbb0b05b0617a19747118ff3be418910dd53c0996268cdee474245cfde') THEN
  RAISE EXCEPTION 'Unqualified schema drift: retain_erasure_files_receipt';
 END IF;
END
$object_guard$;

REVOKE ALL ON FUNCTION public."retain_erasure_files_receipt"(text, text, jsonb, text, text, jsonb) FROM PUBLIC;

DO $pod_414$
BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN GRANT EXECUTE ON FUNCTION public."retain_erasure_files_receipt"(text, text, jsonb, text, text, jsonb) TO service_role; END IF;
END
$pod_414$;

DO $object_guard$
DECLARE actual text;
BEGIN
 SELECT definition INTO actual FROM (SELECT pg_get_functiondef(p.oid) definition FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='retain_erasure_files_upgrade_observation' AND pg_get_function_identity_arguments(p.oid)='owner_id text, lease text, observation jsonb') observed;
 IF actual IS NULL THEN
  EXECUTE $object$CREATE OR REPLACE FUNCTION public.retain_erasure_files_upgrade_observation(owner_id text, lease text, observation jsonb)
 RETURNS boolean
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE current_row public.personal_agent_registry%ROWTYPE; r jsonb;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended(owner_id,171));
 PERFORM pg_advisory_xact_lock(hashtextextended(owner_id,198));
 SELECT * INTO current_row FROM public.personal_agent_registry WHERE user_id=owner_id FOR UPDATE;
 IF NOT FOUND OR current_row.status IS DISTINCT FROM 'suspended' THEN RETURN false; END IF;
 r:=current_row.backend_metadata->'erasure';
 IF r->>'ownerId' IS DISTINCT FROM owner_id
 OR lease IS NULL OR lease='' OR r->'registrySnapshot'->'backend_metadata'->>'upgradeLease' IS DISTINCT FROM lease
 OR public.valid_erasure_files_upgrade_observation(r,observation) IS DISTINCT FROM true THEN RETURN false; END IF;
 IF r ? 'lateFilesUpgradeObservation' THEN RETURN r->'lateFilesUpgradeObservation'=observation; END IF;
 IF r ? 'substrateInventory' THEN RETURN false; END IF;
 UPDATE public.personal_agent_registry SET backend_metadata=jsonb_set(backend_metadata,
  ARRAY['erasure','lateFilesUpgradeObservation'],observation,true) WHERE user_id=owner_id;
 RETURN true;
END;
$function$
$object$;
 ELSIF encode(sha256(convert_to(actual,'UTF8')),'hex') NOT IN ('42aa3c27f82be8594b06f0310f55f8f6c352b2dc05af075ae0bb52790fb15350') THEN
  RAISE EXCEPTION 'Unqualified schema drift: retain_erasure_files_upgrade_observation';
 END IF;
END
$object_guard$;

REVOKE ALL ON FUNCTION public."retain_erasure_files_upgrade_observation"(text, text, jsonb) FROM PUBLIC;

DO $pod_414$
BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN GRANT EXECUTE ON FUNCTION public."retain_erasure_files_upgrade_observation"(text, text, jsonb) TO service_role; END IF;
END
$pod_414$;

DO $object_guard$
DECLARE actual text;
BEGIN
 SELECT definition INTO actual FROM (SELECT pg_get_functiondef(p.oid) definition FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='retain_erasure_kms_receipt' AND pg_get_function_identity_arguments(p.oid)='owner_id text, attempt_id text, expected jsonb, stage text, receipt jsonb') observed;
 IF actual IS NULL THEN
  EXECUTE $object$CREATE OR REPLACE FUNCTION public.retain_erasure_kms_receipt(owner_id text, attempt_id text, expected jsonb, stage text, receipt jsonb)
 RETURNS boolean
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE current_row public.personal_agent_registry%ROWTYPE; r jsonb; k jsonb; previous jsonb; version_name text;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended(owner_id,171));
 PERFORM pg_advisory_xact_lock(hashtextextended(owner_id,198));
 SELECT * INTO current_row FROM public.personal_agent_registry WHERE user_id=owner_id FOR UPDATE;
 IF NOT FOUND OR current_row.status IS DISTINCT FROM 'suspended' THEN RETURN false; END IF;
 r:=current_row.backend_metadata->'erasure';
 IF r->>'ownerId' IS DISTINCT FROM owner_id OR r->>'attemptId' IS DISTINCT FROM attempt_id
 OR public.valid_erasure_kms_receipt(r,stage,receipt) IS DISTINCT FROM true THEN RETURN false; END IF;
 IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid='public.personal_agent_registry'::regclass
 AND tgname='zz_personal_agent_erasure_registry' AND tgenabled IN ('O','A') AND tgtype=27 AND tgnargs=0 AND tgqual IS NULL
 AND tgfoid='public.guard_personal_agent_erasure_registry()'::regprocedure) THEN RETURN false; END IF;
 k:=coalesce(r->'kmsErasure','{}'::jsonb); version_name:=receipt->>'versionName';
 previous:=CASE WHEN stage IN ('inventory','completion') THEN k->stage ELSE k->'versions'->version_name->stage END;
 IF previous IS NOT NULL THEN RETURN stage <> 'admission' AND previous=receipt; END IF;
 IF r IS DISTINCT FROM expected THEN RETURN false; END IF;
 IF stage IN ('inventory','completion') THEN k:=k || jsonb_build_object(stage,receipt);
 ELSE k:=k || jsonb_build_object('versions',coalesce(k->'versions','{}'::jsonb) || jsonb_build_object(version_name,coalesce(k->'versions'->version_name,'{}'::jsonb) || jsonb_build_object(stage,receipt))); END IF;
 UPDATE public.personal_agent_registry SET backend_metadata=jsonb_set(backend_metadata,ARRAY['erasure','kmsErasure'],k,true) WHERE user_id=owner_id;
 RETURN true;
END;
$function$
$object$;
 ELSIF encode(sha256(convert_to(actual,'UTF8')),'hex') NOT IN ('2b14847d7215689a1c0d2664bc250d917069a149be455d001e89b2a5efded68e') THEN
  RAISE EXCEPTION 'Unqualified schema drift: retain_erasure_kms_receipt';
 END IF;
END
$object_guard$;

REVOKE ALL ON FUNCTION public."retain_erasure_kms_receipt"(text, text, jsonb, text, jsonb) FROM PUBLIC;

DO $pod_414$
BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN GRANT EXECUTE ON FUNCTION public."retain_erasure_kms_receipt"(text, text, jsonb, text, jsonb) TO service_role; END IF;
END
$pod_414$;

DO $object_guard$
DECLARE actual text;
BEGIN
 SELECT definition INTO actual FROM (SELECT pg_get_functiondef(p.oid) definition FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='retain_erasure_mail_receipt' AND pg_get_function_identity_arguments(p.oid)='owner_id text, attempt_id text, expected jsonb, kind text, stage text, receipt jsonb') observed;
 IF actual IS NULL THEN
  EXECUTE $object$CREATE OR REPLACE FUNCTION public.retain_erasure_mail_receipt(owner_id text, attempt_id text, expected jsonb, kind text, stage text, receipt jsonb)
 RETURNS boolean
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE current_row public.personal_agent_registry%ROWTYPE; reservation jsonb; resource_id text:=receipt->'resourceObservation'->>'id'; states jsonb; incoming jsonb; kind_state jsonb;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended(owner_id,171));
 PERFORM pg_advisory_xact_lock(hashtextextended(owner_id,198));
 SELECT * INTO current_row FROM public.personal_agent_registry WHERE user_id=owner_id FOR UPDATE;
 IF NOT FOUND OR current_row.status IS DISTINCT FROM 'suspended' THEN RETURN false; END IF;
 reservation := current_row.backend_metadata->'erasure';
 IF reservation->>'ownerId' IS DISTINCT FROM owner_id OR reservation->>'attemptId' IS DISTINCT FROM attempt_id
    OR public.valid_erasure_mail_receipt(reservation,kind,stage,receipt) IS DISTINCT FROM true THEN RETURN false; END IF;
 IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid='public.personal_agent_registry'::regclass
    AND tgname='zz_personal_agent_erasure_registry' AND tgenabled IN ('O','A')
    AND tgtype=27 AND tgnargs=0 AND tgqual IS NULL
    AND tgfoid='public.guard_personal_agent_erasure_registry()'::regprocedure) THEN RETURN false; END IF;
 states:=public.erasure_mail_resource_state(reservation,kind,resource_id);
 IF states ? stage THEN
   RETURN stage <> 'admission' AND states->stage=receipt;
 END IF;
 IF reservation IS DISTINCT FROM expected THEN RETURN false; END IF;
 -- 956: new receipts use exact IDs; an existing single-resource legacy state stays compatible.
 kind_state:=coalesce(reservation->'mailErasure'->kind,'{}'::jsonb);
 IF kind_state->'admission'->'resourceObservation'->>'id'=resource_id OR (kind_state='{}'::jsonb AND (SELECT count(*) FROM jsonb_array_elements(reservation->'substrateInventory'->'plannedResources') x WHERE x->>'type'=kind)=1) THEN
  kind_state:=kind_state||jsonb_build_object(stage,receipt);
 ELSE
  kind_state:=kind_state||jsonb_build_object('resources',coalesce(kind_state->'resources','{}'::jsonb)||jsonb_build_object(resource_id,states||jsonb_build_object(stage,receipt)));
 END IF;
 incoming:=coalesce(reservation->'mailErasure','{}'::jsonb)||jsonb_build_object(kind,kind_state);
 UPDATE public.personal_agent_registry SET backend_metadata=jsonb_set(backend_metadata,ARRAY['erasure','mailErasure'],incoming,true)
 WHERE user_id=owner_id;
 RETURN true;
END;
$function$
$object$;
 ELSIF encode(sha256(convert_to(actual,'UTF8')),'hex') NOT IN ('85762097e6db9d390569ede58b2f222cbf2130c969976b3d65e415df60648623') THEN
  RAISE EXCEPTION 'Unqualified schema drift: retain_erasure_mail_receipt';
 END IF;
END
$object_guard$;

REVOKE ALL ON FUNCTION public."retain_erasure_mail_receipt"(text, text, jsonb, text, text, jsonb) FROM PUBLIC;

DO $pod_414$
BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN GRANT EXECUTE ON FUNCTION public."retain_erasure_mail_receipt"(text, text, jsonb, text, text, jsonb) TO service_role; END IF;
END
$pod_414$;

DO $object_guard$
DECLARE actual text;
BEGIN
 SELECT definition INTO actual FROM (SELECT pg_get_functiondef(p.oid) definition FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='retain_erasure_memory_binding' AND pg_get_function_identity_arguments(p.oid)='owner_id text, attempt_id text, expected jsonb, receipt jsonb') observed;
 IF actual IS NULL THEN
  EXECUTE $object$CREATE OR REPLACE FUNCTION public.retain_erasure_memory_binding(owner_id text, attempt_id text, expected jsonb, receipt jsonb)
 RETURNS boolean
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE current_row public.personal_agent_registry%ROWTYPE; reservation jsonb;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(owner_id,171));
  PERFORM pg_advisory_xact_lock(hashtextextended(owner_id,198));
  SELECT * INTO current_row FROM public.personal_agent_registry WHERE user_id=owner_id FOR UPDATE;
  IF NOT FOUND OR current_row.status IS DISTINCT FROM 'suspended' THEN RETURN false; END IF;
  reservation := current_row.backend_metadata->'erasure';
  IF reservation->>'ownerId' IS DISTINCT FROM owner_id
     OR reservation->>'attemptId' IS DISTINCT FROM attempt_id
     OR NOT public.valid_erasure_memory_binding(reservation,receipt) THEN RETURN false; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger
      WHERE tgrelid='public.personal_agent_registry'::regclass
        AND tgname='zz_personal_agent_erasure_registry' AND tgenabled IN ('O','A')
        AND tgtype=27 AND tgnargs=0 AND tgqual IS NULL
        AND tgfoid='public.guard_personal_agent_erasure_registry()'::regprocedure) THEN RETURN false; END IF;
  IF reservation ? 'memoryBinding' THEN RETURN reservation->'memoryBinding'=receipt; END IF;
  IF reservation IS DISTINCT FROM expected THEN RETURN false; END IF;
  UPDATE public.personal_agent_registry SET backend_metadata=jsonb_set(
    backend_metadata,'{erasure,memoryBinding}',receipt,true) WHERE user_id=owner_id;
  RETURN true;
END;
$function$
$object$;
 ELSIF encode(sha256(convert_to(actual,'UTF8')),'hex') NOT IN ('5fec885efb3fab9c24de0442e72e81cc8703c59e81fdb9fd3bc0b9086f2d66b1') THEN
  RAISE EXCEPTION 'Unqualified schema drift: retain_erasure_memory_binding';
 END IF;
END
$object_guard$;

REVOKE ALL ON FUNCTION public."retain_erasure_memory_binding"(text, text, jsonb, jsonb) FROM PUBLIC;

DO $pod_414$
BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN GRANT EXECUTE ON FUNCTION public."retain_erasure_memory_binding"(text, text, jsonb, jsonb) TO service_role; END IF;
END
$pod_414$;

DO $object_guard$
DECLARE actual text;
BEGIN
 SELECT definition INTO actual FROM (SELECT pg_get_functiondef(p.oid) definition FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='retain_erasure_memory_deletion' AND pg_get_function_identity_arguments(p.oid)='owner_id text, attempt_id text, expected jsonb, receipt jsonb') observed;
 IF actual IS NULL THEN
  EXECUTE $object$CREATE OR REPLACE FUNCTION public.retain_erasure_memory_deletion(owner_id text, attempt_id text, expected jsonb, receipt jsonb)
 RETURNS boolean
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE current_row public.personal_agent_registry%ROWTYPE; reservation jsonb;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(owner_id,171));
  PERFORM pg_advisory_xact_lock(hashtextextended(owner_id,198));
  SELECT * INTO current_row FROM public.personal_agent_registry WHERE user_id=owner_id FOR UPDATE;
  IF NOT FOUND OR current_row.status IS DISTINCT FROM 'suspended' THEN RETURN false; END IF;
  reservation := current_row.backend_metadata->'erasure';
  IF reservation->>'ownerId' IS DISTINCT FROM owner_id
     OR reservation->>'attemptId' IS DISTINCT FROM attempt_id
     OR NOT public.valid_erasure_memory_deletion(reservation,receipt) THEN RETURN false; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger
      WHERE tgrelid='public.personal_agent_registry'::regclass
        AND tgname='zz_personal_agent_erasure_registry' AND tgenabled IN ('O','A')
        AND tgtype=27 AND tgnargs=0 AND tgqual IS NULL
        AND tgfoid='public.guard_personal_agent_erasure_registry()'::regprocedure) THEN RETURN false; END IF;
  IF reservation ? 'memoryDeletion' THEN RETURN reservation->'memoryDeletion'=receipt; END IF;
  IF reservation IS DISTINCT FROM expected THEN RETURN false; END IF;
  UPDATE public.personal_agent_registry SET backend_metadata=jsonb_set(
    backend_metadata,'{erasure,memoryDeletion}',receipt,true) WHERE user_id=owner_id;
  RETURN true;
END;
$function$
$object$;
 ELSIF encode(sha256(convert_to(actual,'UTF8')),'hex') NOT IN ('0757e217ee4909160d5c135a5ba4ea935f2c9aa452e85d1f899f4e87faaf7833') THEN
  RAISE EXCEPTION 'Unqualified schema drift: retain_erasure_memory_deletion';
 END IF;
END
$object_guard$;

REVOKE ALL ON FUNCTION public."retain_erasure_memory_deletion"(text, text, jsonb, jsonb) FROM PUBLIC;

DO $pod_414$
BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN GRANT EXECUTE ON FUNCTION public."retain_erasure_memory_deletion"(text, text, jsonb, jsonb) TO service_role; END IF;
END
$pod_414$;

DO $object_guard$
DECLARE actual text;
BEGIN
 SELECT definition INTO actual FROM (SELECT pg_get_functiondef(p.oid) definition FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='retain_erasure_never_hosted' AND pg_get_function_identity_arguments(p.oid)='owner_id text, attempt_id text, expected jsonb') observed;
 IF actual IS NULL THEN
  EXECUTE $object$CREATE OR REPLACE FUNCTION public.retain_erasure_never_hosted(owner_id text, attempt_id text, expected jsonb)
 RETURNS boolean
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE current_row public.personal_agent_registry%ROWTYPE; r jsonb; receipt jsonb; candidate jsonb;
BEGIN
 IF owner_id IS NULL OR btrim(owner_id)='' THEN RETURN false; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(owner_id,171));
 PERFORM pg_advisory_xact_lock(hashtextextended(owner_id,198));
 SELECT * INTO current_row FROM public.personal_agent_registry WHERE user_id=owner_id FOR UPDATE;
 IF NOT FOUND OR current_row.status IS DISTINCT FROM 'suspended' THEN RETURN false; END IF;
 r:=current_row.backend_metadata->'erasure';
 IF r->>'ownerId' IS DISTINCT FROM owner_id OR r->>'attemptId' IS DISTINCT FROM attempt_id THEN RETURN false; END IF;
 IF NOT EXISTS (SELECT 1 FROM pg_trigger
     WHERE tgrelid='public.personal_agent_registry'::regclass
       AND tgname='zz_personal_agent_erasure_registry' AND tgenabled IN ('O','A')
       AND tgtype=27 AND tgnargs=0 AND tgqual IS NULL
       AND tgfoid='public.guard_personal_agent_erasure_registry()'::regprocedure) THEN RETURN false; END IF;
 IF r ? 'neverHosted' THEN RETURN public.erasure_never_hosted_admitted(owner_id,r) IS TRUE; END IF;
 IF r IS DISTINCT FROM expected THEN RETURN false; END IF;
 receipt:=public.expected_erasure_never_hosted(owner_id,r);
 IF receipt IS NULL THEN RETURN false; END IF;
 candidate:=r||jsonb_build_object('neverHosted',receipt,'grantRelease',jsonb_build_object(
  'ownerId',owner_id,'attemptId',attempt_id,'project',receipt->>'project','status','reserved'));
 IF public.valid_erasure_never_hosted_append(owner_id,r,candidate) IS NOT TRUE
 OR public.project_grant_release_is_exclusive(owner_id,receipt->>'project') IS NOT TRUE THEN RETURN false; END IF;
 UPDATE public.personal_agent_registry SET backend_metadata=jsonb_set(backend_metadata,'{erasure}',candidate,true)
 WHERE user_id=owner_id;
 RETURN true;
END;
$function$
$object$;
 ELSIF encode(sha256(convert_to(actual,'UTF8')),'hex') NOT IN ('d97aebc47bbf1de36b126ff9f1700f4c51b682b44addd18c29fd46aefc5b8809') THEN
  RAISE EXCEPTION 'Unqualified schema drift: retain_erasure_never_hosted';
 END IF;
END
$object_guard$;

REVOKE ALL ON FUNCTION public."retain_erasure_never_hosted"(text, text, jsonb) FROM PUBLIC;

DO $pod_414$
BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN GRANT EXECUTE ON FUNCTION public."retain_erasure_never_hosted"(text, text, jsonb) TO service_role; END IF;
END
$pod_414$;

DO $object_guard$
DECLARE actual text;
BEGIN
 SELECT definition INTO actual FROM (SELECT pg_get_functiondef(p.oid) definition FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='retain_erasure_owner_access' AND pg_get_function_identity_arguments(p.oid)='owner_id text, attempt_id text, expected jsonb, receipt jsonb') observed;
 IF actual IS NULL THEN
  EXECUTE $object$CREATE OR REPLACE FUNCTION public.retain_erasure_owner_access(owner_id text, attempt_id text, expected jsonb, receipt jsonb)
 RETURNS boolean
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE current_row public.personal_agent_registry%ROWTYPE; reservation jsonb;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(owner_id,171));
  PERFORM pg_advisory_xact_lock(hashtextextended(owner_id,198));
  SELECT * INTO current_row FROM public.personal_agent_registry WHERE user_id=owner_id FOR UPDATE;
  IF NOT FOUND OR current_row.status IS DISTINCT FROM 'suspended' THEN RETURN false; END IF;
  reservation := current_row.backend_metadata->'erasure';
  IF reservation->>'ownerId' IS DISTINCT FROM owner_id
     OR reservation->>'attemptId' IS DISTINCT FROM attempt_id
     OR NOT public.valid_erasure_owner_access(reservation,receipt) THEN RETURN false; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger
      WHERE tgrelid='public.personal_agent_registry'::regclass
        AND tgname='zz_personal_agent_erasure_registry' AND tgenabled IN ('O','A')
        AND tgtype=27 AND tgnargs=0 AND tgqual IS NULL
        AND tgfoid='public.guard_personal_agent_erasure_registry()'::regprocedure) THEN RETURN false; END IF;
  IF reservation ? 'ownerAccessErasure' THEN RETURN reservation->'ownerAccessErasure'=receipt; END IF;
  IF reservation IS DISTINCT FROM expected THEN RETURN false; END IF;
  UPDATE public.personal_agent_registry SET backend_metadata=jsonb_set(
    backend_metadata,'{erasure,ownerAccessErasure}',receipt,true) WHERE user_id=owner_id;
  RETURN true;
END;
$function$
$object$;
 ELSIF encode(sha256(convert_to(actual,'UTF8')),'hex') NOT IN ('dadf81bea4d040d35d60ffe372953b92f0e2fc51534c0b75554829b47193cd14') THEN
  RAISE EXCEPTION 'Unqualified schema drift: retain_erasure_owner_access';
 END IF;
END
$object_guard$;

REVOKE ALL ON FUNCTION public."retain_erasure_owner_access"(text, text, jsonb, jsonb) FROM PUBLIC;

DO $pod_414$
BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN GRANT EXECUTE ON FUNCTION public."retain_erasure_owner_access"(text, text, jsonb, jsonb) TO service_role; END IF;
END
$pod_414$;

DO $object_guard$
DECLARE actual text;
BEGIN
 SELECT definition INTO actual FROM (SELECT pg_get_functiondef(p.oid) definition FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='retain_erasure_owner_access_checkpoint' AND pg_get_function_identity_arguments(p.oid)='owner_id text, attempt_id text, expected jsonb, checkpoint jsonb') observed;
 IF actual IS NULL THEN
  EXECUTE $object$CREATE OR REPLACE FUNCTION public.retain_erasure_owner_access_checkpoint(owner_id text, attempt_id text, expected jsonb, checkpoint jsonb)
 RETURNS boolean
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE current_row public.personal_agent_registry%ROWTYPE; reservation jsonb;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(owner_id,171));
  PERFORM pg_advisory_xact_lock(hashtextextended(owner_id,198));
  SELECT * INTO current_row FROM public.personal_agent_registry WHERE user_id=owner_id FOR UPDATE;
  IF NOT FOUND OR current_row.status IS DISTINCT FROM 'suspended' THEN RETURN false; END IF;
  reservation := current_row.backend_metadata->'erasure';
  IF reservation->>'ownerId' IS DISTINCT FROM owner_id
     OR reservation->>'attemptId' IS DISTINCT FROM attempt_id
     OR NOT public.valid_erasure_owner_access_checkpoint(reservation,checkpoint) THEN RETURN false; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger
      WHERE tgrelid='public.personal_agent_registry'::regclass
        AND tgname='zz_personal_agent_erasure_registry' AND tgenabled IN ('O','A')
        AND tgtype=27 AND tgnargs=0 AND tgqual IS NULL
        AND tgfoid='public.guard_personal_agent_erasure_registry()'::regprocedure) THEN RETURN false; END IF;
  IF reservation ? 'agentCryptoErase' THEN RETURN reservation->'agentCryptoErase'=checkpoint; END IF;
  IF reservation ? 'ownerAccessErasure' OR reservation IS DISTINCT FROM expected THEN RETURN false; END IF;
  UPDATE public.personal_agent_registry SET backend_metadata=jsonb_set(
    backend_metadata,'{erasure,agentCryptoErase}',checkpoint,true) WHERE user_id=owner_id;
  RETURN true;
END;
$function$
$object$;
 ELSIF encode(sha256(convert_to(actual,'UTF8')),'hex') NOT IN ('a4eb5113a412f8e4bbcb58de61ad230fcd58d0d0186c3e1da7d184986560f4cd') THEN
  RAISE EXCEPTION 'Unqualified schema drift: retain_erasure_owner_access_checkpoint';
 END IF;
END
$object_guard$;

REVOKE ALL ON FUNCTION public."retain_erasure_owner_access_checkpoint"(text, text, jsonb, jsonb) FROM PUBLIC;

DO $pod_414$
BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN GRANT EXECUTE ON FUNCTION public."retain_erasure_owner_access_checkpoint"(text, text, jsonb, jsonb) TO service_role; END IF;
END
$pod_414$;

DO $object_guard$
DECLARE actual text;
BEGIN
 SELECT definition INTO actual FROM (SELECT pg_get_functiondef(p.oid) definition FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='retain_erasure_repository_grant_receipt' AND pg_get_function_identity_arguments(p.oid)='owner_id text, attempt_id text, expected jsonb, stage text, receipt jsonb') observed;
 IF actual IS NULL THEN
  EXECUTE $object$CREATE OR REPLACE FUNCTION public.retain_erasure_repository_grant_receipt(owner_id text, attempt_id text, expected jsonb, stage text, receipt jsonb)
 RETURNS boolean
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE current_row public.personal_agent_registry%ROWTYPE; r jsonb; s jsonb;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended(owner_id,171));
 PERFORM pg_advisory_xact_lock(hashtextextended(owner_id,198));
 SELECT * INTO current_row FROM public.personal_agent_registry WHERE user_id=owner_id FOR UPDATE;
 IF NOT FOUND OR current_row.status IS DISTINCT FROM 'suspended' THEN RETURN false; END IF;
 r:=current_row.backend_metadata->'erasure';
 IF r->>'ownerId' IS DISTINCT FROM owner_id OR r->>'attemptId' IS DISTINCT FROM attempt_id
 OR public.valid_erasure_repository_grant_receipt(r,stage,receipt) IS DISTINCT FROM true THEN RETURN false; END IF;
 IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid='public.personal_agent_registry'::regclass
 AND tgname='zz_personal_agent_erasure_registry' AND tgenabled IN ('O','A') AND tgtype=27 AND tgnargs=0 AND tgqual IS NULL
 AND tgfoid='public.guard_personal_agent_erasure_registry()'::regprocedure) THEN RETURN false; END IF;
 IF public.project_grant_release_is_exclusive(owner_id,r->'grantRelease'->>'project') IS DISTINCT FROM true THEN RETURN false; END IF;
 s:=coalesce(r->'repositoryGrantErasure','{}'::jsonb);
 IF s ? stage THEN RETURN stage <> 'admission' AND s->stage=receipt; END IF;
 IF r IS DISTINCT FROM expected THEN RETURN false; END IF;
 UPDATE public.personal_agent_registry SET backend_metadata=jsonb_set(backend_metadata,ARRAY['erasure','repositoryGrantErasure'],s || jsonb_build_object(stage,receipt),true) WHERE user_id=owner_id;
 RETURN true;
END;
$function$
$object$;
 ELSIF encode(sha256(convert_to(actual,'UTF8')),'hex') NOT IN ('034377f7ee322099d880c57c68bd2fb4e74db5a293f0da4e709de30c6d952820') THEN
  RAISE EXCEPTION 'Unqualified schema drift: retain_erasure_repository_grant_receipt';
 END IF;
END
$object_guard$;

REVOKE ALL ON FUNCTION public."retain_erasure_repository_grant_receipt"(text, text, jsonb, text, jsonb) FROM PUBLIC;

DO $pod_414$
BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN GRANT EXECUTE ON FUNCTION public."retain_erasure_repository_grant_receipt"(text, text, jsonb, text, jsonb) TO service_role; END IF;
END
$pod_414$;

DO $object_guard$
DECLARE actual text;
BEGIN
 SELECT definition INTO actual FROM (SELECT pg_get_functiondef(p.oid) definition FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='retain_erasure_repository_inventory' AND pg_get_function_identity_arguments(p.oid)='owner_id text, attempt_id text, expected jsonb, receipt jsonb') observed;
 IF actual IS NULL THEN
  EXECUTE $object$CREATE OR REPLACE FUNCTION public.retain_erasure_repository_inventory(owner_id text, attempt_id text, expected jsonb, receipt jsonb)
 RETURNS boolean
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE current_row public.personal_agent_registry%ROWTYPE; r jsonb;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended(owner_id,171));
 PERFORM pg_advisory_xact_lock(hashtextextended(owner_id,198));
 SELECT * INTO current_row FROM public.personal_agent_registry WHERE user_id=owner_id FOR UPDATE;
 IF NOT FOUND OR current_row.status IS DISTINCT FROM 'suspended' THEN RETURN false; END IF;
 r:=current_row.backend_metadata->'erasure';
 IF r->>'ownerId' IS DISTINCT FROM owner_id OR r->>'attemptId' IS DISTINCT FROM attempt_id
 OR public.valid_erasure_repository_inventory(r,receipt) IS DISTINCT FROM true THEN RETURN false; END IF;
 IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid='public.personal_agent_registry'::regclass
 AND tgname='zz_personal_agent_erasure_registry' AND tgenabled IN ('O','A') AND tgtype=27 AND tgnargs=0 AND tgqual IS NULL
 AND tgfoid='public.guard_personal_agent_erasure_registry()'::regprocedure) THEN RETURN false; END IF;
 IF public.project_grant_release_is_exclusive(owner_id,r->'grantRelease'->>'project') IS DISTINCT FROM true THEN RETURN false; END IF;
 IF r ? 'repositoryInventory' THEN RETURN r->'repositoryInventory'=receipt; END IF;
 IF r IS DISTINCT FROM expected THEN RETURN false; END IF;
 UPDATE public.personal_agent_registry SET backend_metadata=jsonb_set(backend_metadata,'{erasure,repositoryInventory}',receipt,true) WHERE user_id=owner_id;
 RETURN true;
END;
$function$
$object$;
 ELSIF encode(sha256(convert_to(actual,'UTF8')),'hex') NOT IN ('dc166ff45399469d9303d204e97b8e7c332d6b34f0e1b96cee9a3a743968655a') THEN
  RAISE EXCEPTION 'Unqualified schema drift: retain_erasure_repository_inventory';
 END IF;
END
$object_guard$;

REVOKE ALL ON FUNCTION public."retain_erasure_repository_inventory"(text, text, jsonb, jsonb) FROM PUBLIC;

DO $pod_414$
BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN GRANT EXECUTE ON FUNCTION public."retain_erasure_repository_inventory"(text, text, jsonb, jsonb) TO service_role; END IF;
END
$pod_414$;

DO $object_guard$
DECLARE actual text;
BEGIN
 SELECT definition INTO actual FROM (SELECT pg_get_functiondef(p.oid) definition FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='retain_erasure_repository_retention' AND pg_get_function_identity_arguments(p.oid)='owner_id text, attempt_id text, expected jsonb, receipt jsonb') observed;
 IF actual IS NULL THEN
  EXECUTE $object$CREATE OR REPLACE FUNCTION public.retain_erasure_repository_retention(owner_id text, attempt_id text, expected jsonb, receipt jsonb)
 RETURNS boolean
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE current_row public.personal_agent_registry%ROWTYPE; r jsonb;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended(owner_id,171));
 PERFORM pg_advisory_xact_lock(hashtextextended(owner_id,198));
 SELECT * INTO current_row FROM public.personal_agent_registry WHERE user_id=owner_id FOR UPDATE;
 IF NOT FOUND OR current_row.status IS DISTINCT FROM 'suspended' THEN RETURN false; END IF;
 r:=current_row.backend_metadata->'erasure';
 IF r->>'ownerId' IS DISTINCT FROM owner_id OR r->>'attemptId' IS DISTINCT FROM attempt_id
 OR public.valid_erasure_repository_retention(r,receipt) IS DISTINCT FROM true THEN RETURN false; END IF;
 IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid='public.personal_agent_registry'::regclass
 AND tgname='zz_personal_agent_erasure_registry' AND tgenabled IN ('O','A') AND tgtype=27 AND tgnargs=0 AND tgqual IS NULL
 AND tgfoid='public.guard_personal_agent_erasure_registry()'::regprocedure) THEN RETURN false; END IF;
 IF public.project_grant_release_is_exclusive(owner_id,r->'grantRelease'->>'project') IS DISTINCT FROM true THEN RETURN false; END IF;
 IF r ? 'repositoryRetention' THEN RETURN r->'repositoryRetention'=receipt; END IF;
 IF r IS DISTINCT FROM expected THEN RETURN false; END IF;
 UPDATE public.personal_agent_registry SET backend_metadata=jsonb_set(backend_metadata,'{erasure,repositoryRetention}',receipt,true) WHERE user_id=owner_id;
 RETURN true;
END;
$function$
$object$;
 ELSIF encode(sha256(convert_to(actual,'UTF8')),'hex') NOT IN ('db02c921cd096670351e10c0d3917d7b37327d922deb260ce5557d1bedf0594b') THEN
  RAISE EXCEPTION 'Unqualified schema drift: retain_erasure_repository_retention';
 END IF;
END
$object_guard$;

REVOKE ALL ON FUNCTION public."retain_erasure_repository_retention"(text, text, jsonb, jsonb) FROM PUBLIC;

DO $pod_414$
BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN GRANT EXECUTE ON FUNCTION public."retain_erasure_repository_retention"(text, text, jsonb, jsonb) TO service_role; END IF;
END
$pod_414$;

DO $object_guard$
DECLARE actual text;
BEGIN
 SELECT definition INTO actual FROM (SELECT pg_get_functiondef(p.oid) definition FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='retain_erasure_runtime_grant_receipt' AND pg_get_function_identity_arguments(p.oid)='owner_id text, attempt_id text, expected jsonb, stage text, receipt jsonb') observed;
 IF actual IS NULL THEN
  EXECUTE $object$CREATE OR REPLACE FUNCTION public.retain_erasure_runtime_grant_receipt(owner_id text, attempt_id text, expected jsonb, stage text, receipt jsonb)
 RETURNS boolean
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE current_row public.personal_agent_registry%ROWTYPE; r jsonb; s jsonb; path text[]; quota boolean;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended(owner_id,171));
 PERFORM pg_advisory_xact_lock(hashtextextended(owner_id,198));
 SELECT * INTO current_row FROM public.personal_agent_registry WHERE user_id=owner_id FOR UPDATE;
 IF NOT FOUND OR current_row.status IS DISTINCT FROM 'suspended' THEN RETURN false; END IF;
 r:=current_row.backend_metadata->'erasure';
 IF r->>'ownerId' IS DISTINCT FROM owner_id OR r->>'attemptId' IS DISTINCT FROM attempt_id
 OR public.valid_erasure_runtime_grant_receipt(r,stage,receipt) IS DISTINCT FROM true THEN RETURN false; END IF;
 IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid='public.personal_agent_registry'::regclass
 AND tgname='zz_personal_agent_erasure_registry' AND tgenabled IN ('O','A') AND tgtype=27 AND tgnargs=0 AND tgqual IS NULL
 AND tgfoid='public.guard_personal_agent_erasure_registry()'::regprocedure) THEN RETURN false; END IF;
 IF public.project_grant_release_is_exclusive(owner_id,r->'grantRelease'->>'project') IS DISTINCT FROM true THEN RETURN false; END IF;
 quota:=receipt->'bindingObservation'->>'role'='roles/serviceusage.serviceUsageConsumer';
 path:=CASE WHEN quota THEN ARRAY['erasure','runtimeGrantErasure','quota'] ELSE ARRAY['erasure','runtimeGrantErasure'] END;
 s:=coalesce(CASE WHEN quota THEN r->'runtimeGrantErasure'->'quota' ELSE r->'runtimeGrantErasure' END,'{}'::jsonb);
 IF s ? stage THEN RETURN stage <> 'admission' AND s->stage=receipt; END IF;
 IF r IS DISTINCT FROM expected OR (quota AND jsonb_typeof(r->'runtimeGrantErasure') IS DISTINCT FROM 'object') THEN RETURN false; END IF;
 UPDATE public.personal_agent_registry SET backend_metadata=jsonb_set(backend_metadata,path,s || jsonb_build_object(stage,receipt),true) WHERE user_id=owner_id;
 RETURN true;
END;
$function$
$object$;
 ELSIF encode(sha256(convert_to(actual,'UTF8')),'hex') NOT IN ('abd857d36e71071cb9e98dfc641a4d25b5f010ad1b1a5cf247f25c6b9531850a') THEN
  RAISE EXCEPTION 'Unqualified schema drift: retain_erasure_runtime_grant_receipt';
 END IF;
END
$object_guard$;

REVOKE ALL ON FUNCTION public."retain_erasure_runtime_grant_receipt"(text, text, jsonb, text, jsonb) FROM PUBLIC;

DO $pod_414$
BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN GRANT EXECUTE ON FUNCTION public."retain_erasure_runtime_grant_receipt"(text, text, jsonb, text, jsonb) TO service_role; END IF;
END
$pod_414$;

DO $object_guard$
DECLARE actual text;
BEGIN
 SELECT definition INTO actual FROM (SELECT pg_get_functiondef(p.oid) definition FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='retain_erasure_secret_receipt' AND pg_get_function_identity_arguments(p.oid)='owner_id text, attempt_id text, expected jsonb, stage text, receipt jsonb') observed;
 IF actual IS NULL THEN
  EXECUTE $object$CREATE OR REPLACE FUNCTION public.retain_erasure_secret_receipt(owner_id text, attempt_id text, expected jsonb, stage text, receipt jsonb)
 RETURNS boolean
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE current_row public.personal_agent_registry%ROWTYPE; r jsonb; s jsonb;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended(owner_id,171));
 PERFORM pg_advisory_xact_lock(hashtextextended(owner_id,198));
 SELECT * INTO current_row FROM public.personal_agent_registry WHERE user_id=owner_id FOR UPDATE;
 IF NOT FOUND OR current_row.status IS DISTINCT FROM 'suspended' THEN RETURN false; END IF;
 r:=current_row.backend_metadata->'erasure';
 IF r->>'ownerId' IS DISTINCT FROM owner_id OR r->>'attemptId' IS DISTINCT FROM attempt_id
 OR public.valid_erasure_secret_receipt(r,stage,receipt) IS DISTINCT FROM true THEN RETURN false; END IF;
 IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid='public.personal_agent_registry'::regclass
 AND tgname='zz_personal_agent_erasure_registry' AND tgenabled IN ('O','A') AND tgtype=27 AND tgnargs=0 AND tgqual IS NULL
 AND tgfoid='public.guard_personal_agent_erasure_registry()'::regprocedure) THEN RETURN false; END IF;
 s:=coalesce(r->'secretErasure','{}'::jsonb);
 IF s ? stage THEN RETURN stage <> 'admission' AND s->stage=receipt; END IF;
 IF r IS DISTINCT FROM expected THEN RETURN false; END IF;
 UPDATE public.personal_agent_registry SET backend_metadata=jsonb_set(backend_metadata,ARRAY['erasure','secretErasure'],s || jsonb_build_object(stage,receipt),true) WHERE user_id=owner_id;
 RETURN true;
END;
$function$
$object$;
 ELSIF encode(sha256(convert_to(actual,'UTF8')),'hex') NOT IN ('b6f6fb4caefa2423e194b82573484a85f0dd9076e3b7708dd710f057105368f7') THEN
  RAISE EXCEPTION 'Unqualified schema drift: retain_erasure_secret_receipt';
 END IF;
END
$object_guard$;

REVOKE ALL ON FUNCTION public."retain_erasure_secret_receipt"(text, text, jsonb, text, jsonb) FROM PUBLIC;

DO $pod_414$
BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN GRANT EXECUTE ON FUNCTION public."retain_erasure_secret_receipt"(text, text, jsonb, text, jsonb) TO service_role; END IF;
END
$pod_414$;

DO $object_guard$
DECLARE actual text;
BEGIN
 SELECT definition INTO actual FROM (SELECT pg_get_functiondef(p.oid) definition FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='retain_erasure_substrate_inventory' AND pg_get_function_identity_arguments(p.oid)='owner_id text, attempt_id text, expected jsonb') observed;
 IF actual IS NULL THEN
  EXECUTE $object$CREATE OR REPLACE FUNCTION public.retain_erasure_substrate_inventory(owner_id text, attempt_id text, expected jsonb)
 RETURNS boolean
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE current_row public.personal_agent_registry%ROWTYPE; reservation jsonb; inventory jsonb;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended(owner_id,171));
 PERFORM pg_advisory_xact_lock(hashtextextended(owner_id,198));
 SELECT * INTO current_row FROM public.personal_agent_registry WHERE user_id=owner_id FOR UPDATE;
 IF NOT FOUND OR current_row.status IS DISTINCT FROM 'suspended' THEN RETURN false; END IF;
 reservation := current_row.backend_metadata->'erasure';
 -- Derive from the protected snapshot, never caller-supplied resource names.
 inventory := public.effective_erasure_substrate_inventory(reservation);
 IF reservation->>'ownerId' IS DISTINCT FROM owner_id
    OR reservation->>'attemptId' IS DISTINCT FROM attempt_id
    OR public.valid_erasure_substrate_inventory(reservation,inventory) IS DISTINCT FROM true THEN RETURN false; END IF;
 IF NOT EXISTS (SELECT 1 FROM pg_trigger
    WHERE tgrelid='public.personal_agent_registry'::regclass
      AND tgname='zz_personal_agent_erasure_registry' AND tgenabled IN ('O','A')
      AND tgtype=27 AND tgnargs=0 AND tgqual IS NULL
      AND tgfoid='public.guard_personal_agent_erasure_registry()'::regprocedure) THEN RETURN false; END IF;
 IF reservation ? 'substrateInventory' THEN RETURN reservation->'substrateInventory'=inventory; END IF;
 IF reservation IS DISTINCT FROM expected THEN RETURN false; END IF;
 UPDATE public.personal_agent_registry SET backend_metadata=jsonb_set(
    backend_metadata,ARRAY['erasure','substrateInventory'],inventory,true) WHERE user_id=owner_id;
 RETURN true;
END;
$function$
$object$;
 ELSIF encode(sha256(convert_to(actual,'UTF8')),'hex') NOT IN ('9c9eaeaf85a40df8479c200538e133dd8d9901ad007f4b5452249e2e311dedf0') THEN
  RAISE EXCEPTION 'Unqualified schema drift: retain_erasure_substrate_inventory';
 END IF;
END
$object_guard$;

REVOKE ALL ON FUNCTION public."retain_erasure_substrate_inventory"(text, text, jsonb) FROM PUBLIC;

DO $pod_414$
BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN GRANT EXECUTE ON FUNCTION public."retain_erasure_substrate_inventory"(text, text, jsonb) TO service_role; END IF;
END
$pod_414$;

DO $object_guard$
DECLARE actual text;
BEGIN
 SELECT definition INTO actual FROM (SELECT pg_get_functiondef(p.oid) definition FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='retain_erasure_upgrade_ack' AND pg_get_function_identity_arguments(p.oid)='owner_id text, lease text, receipt jsonb') observed;
 IF actual IS NULL THEN
  EXECUTE $object$CREATE OR REPLACE FUNCTION public.retain_erasure_upgrade_ack(owner_id text, lease text, receipt jsonb)
 RETURNS boolean
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
  current_row public.personal_agent_registry%ROWTYPE;
  reservation jsonb;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(owner_id, 171));
  PERFORM pg_advisory_xact_lock(hashtextextended(owner_id, 198));
  SELECT * INTO current_row FROM public.personal_agent_registry WHERE user_id=owner_id FOR UPDATE;
  reservation := current_row.backend_metadata->'erasure';
  IF reservation IS NULL OR lease IS NULL OR
     reservation->'registrySnapshot'->'backend_metadata'->>'upgradeLease' IS DISTINCT FROM lease OR
     NOT public.valid_erasure_upgrade_ack(reservation, receipt) THEN
    RETURN false;
  END IF;
  IF reservation ? 'lateUpgradeAcknowledgement' THEN
    RETURN reservation->'lateUpgradeAcknowledgement' = receipt;
  END IF;
  UPDATE public.personal_agent_registry SET backend_metadata = jsonb_set(
    backend_metadata, '{erasure,lateUpgradeAcknowledgement}', receipt, true
  ) WHERE user_id=owner_id;
  RETURN true;
END;
$function$
$object$;
 ELSIF encode(sha256(convert_to(actual,'UTF8')),'hex') NOT IN ('d89c390224647a095458aaa11d5c68e84ac23531c1247dda824093aa627851ef') THEN
  RAISE EXCEPTION 'Unqualified schema drift: retain_erasure_upgrade_ack';
 END IF;
END
$object_guard$;

REVOKE ALL ON FUNCTION public."retain_erasure_upgrade_ack"(text, text, jsonb) FROM PUBLIC;

DO $pod_414$
BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN GRANT EXECUTE ON FUNCTION public."retain_erasure_upgrade_ack"(text, text, jsonb) TO service_role; END IF;
END
$pod_414$;

DO $object_guard$
DECLARE actual text;
BEGIN
 SELECT definition INTO actual FROM (SELECT pg_get_functiondef(p.oid) definition FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='retain_erasure_writer_receipt' AND pg_get_function_identity_arguments(p.oid)='owner_id text, attempt_id text, expected jsonb, stage text, receipt jsonb') observed;
 IF actual IS NULL THEN
  EXECUTE $object$CREATE OR REPLACE FUNCTION public.retain_erasure_writer_receipt(owner_id text, attempt_id text, expected jsonb, stage text, receipt jsonb)
 RETURNS boolean
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE current_row public.personal_agent_registry%ROWTYPE; reservation jsonb;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended(owner_id,171));
 PERFORM pg_advisory_xact_lock(hashtextextended(owner_id,198));
 SELECT * INTO current_row FROM public.personal_agent_registry WHERE user_id=owner_id FOR UPDATE;
 IF NOT FOUND OR current_row.status IS DISTINCT FROM 'suspended' THEN RETURN false; END IF;
 reservation := current_row.backend_metadata->'erasure';
 IF reservation->>'ownerId' IS DISTINCT FROM owner_id OR reservation->>'attemptId' IS DISTINCT FROM attempt_id
    OR public.valid_erasure_writer_receipt(reservation,stage,receipt) IS DISTINCT FROM true THEN RETURN false; END IF;
 IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid='public.personal_agent_registry'::regclass
    AND tgname='zz_personal_agent_erasure_registry' AND tgenabled IN ('O','A')
    AND tgtype=27 AND tgnargs=0 AND tgqual IS NULL
    AND tgfoid='public.guard_personal_agent_erasure_registry()'::regprocedure) THEN RETURN false; END IF;
 IF reservation ? stage THEN
   RETURN stage <> 'writerAdmission' AND reservation->stage=receipt;
 END IF;
 IF reservation IS DISTINCT FROM expected THEN RETURN false; END IF;
 UPDATE public.personal_agent_registry SET backend_metadata=jsonb_set(backend_metadata,ARRAY['erasure',stage],receipt,true)
 WHERE user_id=owner_id;
 RETURN true;
END;
$function$
$object$;
 ELSIF encode(sha256(convert_to(actual,'UTF8')),'hex') NOT IN ('e28015965c66fb83e2ff0825cede4cca037735bd68664feebcc025a2d3c212ba') THEN
  RAISE EXCEPTION 'Unqualified schema drift: retain_erasure_writer_receipt';
 END IF;
END
$object_guard$;

REVOKE ALL ON FUNCTION public."retain_erasure_writer_receipt"(text, text, jsonb, text, jsonb) FROM PUBLIC;

DO $pod_414$
BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN GRANT EXECUTE ON FUNCTION public."retain_erasure_writer_receipt"(text, text, jsonb, text, jsonb) TO service_role; END IF;
END
$pod_414$;

DO $object_guard$
DECLARE actual text;
BEGIN
 SELECT definition INTO actual FROM (SELECT pg_get_functiondef(p.oid) definition FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='retain_personal_agent_provision_ack' AND pg_get_function_identity_arguments(p.oid)='owner_id text, receipt jsonb') observed;
 IF actual IS NULL THEN
  EXECUTE $object$CREATE OR REPLACE FUNCTION public.retain_personal_agent_provision_ack(owner_id text, receipt jsonb)
 RETURNS boolean
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE reservation jsonb; current_row public.personal_agent_registry%ROWTYPE; prior_setting text;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended(owner_id,171));
 PERFORM pg_advisory_xact_lock(hashtextextended(owner_id,198));
 SELECT * INTO current_row FROM public.personal_agent_registry WHERE user_id=owner_id FOR UPDATE;
 IF NOT FOUND THEN RETURN false; END IF;
 reservation := current_row.backend_metadata->'erasure';
 IF reservation IS NULL THEN
   IF current_row.backend_metadata->'provisionAttempt'->>'phase' IS DISTINCT FROM 'failed' THEN RETURN false; END IF;
   reservation := jsonb_build_object('ownerId',owner_id,'registrySnapshot',to_jsonb(current_row));
   IF NOT public.valid_erasure_provision_ack(reservation,receipt) THEN RETURN false; END IF;
   IF current_row.backend_metadata->'provisionAttempt' ? 'lateAcknowledgement' THEN
     RETURN current_row.backend_metadata->'provisionAttempt'->'lateAcknowledgement'=receipt;
   END IF;
   prior_setting := current_setting('hussh.provision_attempt',true);
   PERFORM set_config('hussh.provision_attempt',receipt->>'attemptId',true);
   UPDATE public.personal_agent_registry SET backend_metadata=jsonb_set(
     backend_metadata,'{provisionAttempt,lateAcknowledgement}',receipt,true) WHERE user_id=owner_id;
   PERFORM set_config('hussh.provision_attempt',coalesce(prior_setting,''),true);
   RETURN true;
 END IF;
 IF NOT public.valid_erasure_provision_ack(reservation,receipt) THEN RETURN false; END IF;
 IF reservation ? 'lateProvisionAcknowledgement' THEN
   RETURN reservation->'lateProvisionAcknowledgement'=receipt;
 END IF;
 UPDATE public.personal_agent_registry SET backend_metadata=jsonb_set(
   backend_metadata,'{erasure,lateProvisionAcknowledgement}',receipt,true) WHERE user_id=owner_id;
 RETURN true;
END;
$function$
$object$;
 ELSIF encode(sha256(convert_to(actual,'UTF8')),'hex') NOT IN ('c6e9fa0398c14a1ac408bf8758a8961af291c6f6d71240b2d85a09c88eaa6194') THEN
  RAISE EXCEPTION 'Unqualified schema drift: retain_personal_agent_provision_ack';
 END IF;
END
$object_guard$;

REVOKE ALL ON FUNCTION public."retain_personal_agent_provision_ack"(text, jsonb) FROM PUBLIC;

DO $pod_414$
BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN GRANT EXECUTE ON FUNCTION public."retain_personal_agent_provision_ack"(text, jsonb) TO service_role; END IF;
END
$pod_414$;

DO $object_guard$
DECLARE actual text;
BEGIN
 SELECT definition INTO actual FROM (SELECT pg_get_functiondef(p.oid) definition FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='retire_superseded_pod_signing_key' AND pg_get_function_identity_arguments(p.oid)='') observed;
 IF actual IS NULL THEN
  EXECUTE $object$CREATE OR REPLACE FUNCTION public.retire_superseded_pod_signing_key()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
BEGIN
  NEW.pod_signing_pubkey := NULL;
  NEW.pod_signing_key_id := NULL;
  RETURN NEW;
END;
$function$
$object$;
 ELSIF encode(sha256(convert_to(actual,'UTF8')),'hex') NOT IN ('35a5842730eb308068a703238bae6b1a969de7a8af41b623110c10cbd5c7371a') THEN
  RAISE EXCEPTION 'Unqualified schema drift: retire_superseded_pod_signing_key';
 END IF;
END
$object_guard$;

REVOKE ALL ON FUNCTION public."retire_superseded_pod_signing_key"() FROM PUBLIC;

DO $pod_414$
BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN GRANT EXECUTE ON FUNCTION public."retire_superseded_pod_signing_key"() TO service_role; END IF;
END
$pod_414$;

DO $object_guard$
DECLARE actual text;
BEGIN
 SELECT definition INTO actual FROM (SELECT pg_get_functiondef(p.oid) definition FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='valid_azure_arm_acknowledgement' AND pg_get_function_identity_arguments(p.oid)='receipt jsonb, target text') observed;
 IF actual IS NULL THEN
  EXECUTE $object$CREATE OR REPLACE FUNCTION public.valid_azure_arm_acknowledgement(receipt jsonb, target text)
 RETURNS boolean
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public'
AS $function$
 SELECT (NOT receipt ? 'operationKind' OR receipt->'operationKind'='null'::jsonb
       OR receipt->>'operationKind' IN ('azure-asyncoperation','location'))
    AND receipt ?& ARRAY['status','operationUrl','operationUrlSha256']
    AND jsonb_typeof(receipt->'status')='number' AND (receipt->>'status' ~ '^[2-5][0-9]{2}$') IS TRUE
    AND (receipt->'operationUrlSha256'='null'::jsonb OR (
      jsonb_typeof(receipt->'operationUrlSha256')='string'
      AND receipt->>'operationUrlSha256' ~ '^[0-9a-f]{64}$'))
    AND ((receipt->'operationUrl'='null'::jsonb) OR (
      jsonb_typeof(receipt->'operationUrl')='string'
      AND starts_with(receipt->>'operationUrl','https://management.azure.com/subscriptions/'||
        split_part(target,'/',3)||'/')
      AND receipt->>'operationUrl' ~ '^https://management\.azure\.com/[A-Za-z0-9_./():-]+(\?(api-version=\d{4}-\d{2}-\d{2}(-preview)?|monitor=true)(&(api-version=\d{4}-\d{2}-\d{2}(-preview)?|monitor=true))?)?$'
      AND NOT (receipt->>'operationUrl' ~ '/\.{1,2}(/|\?|$)')
      AND receipt->>'operationUrlSha256'=encode(sha256(convert_to(receipt->>'operationUrl','UTF8')),'hex')));
$function$
$object$;
 ELSIF encode(sha256(convert_to(actual,'UTF8')),'hex') NOT IN ('8d91b24d1b1bbc6dbd0c6137f348682a2dce6d96d4a6c7b93c95421126b54c9e') THEN
  RAISE EXCEPTION 'Unqualified schema drift: valid_azure_arm_acknowledgement';
 END IF;
END
$object_guard$;

REVOKE ALL ON FUNCTION public."valid_azure_arm_acknowledgement"(jsonb, text) FROM PUBLIC;

DO $pod_414$
BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN GRANT EXECUTE ON FUNCTION public."valid_azure_arm_acknowledgement"(jsonb, text) TO service_role; END IF;
END
$pod_414$;

DO $object_guard$
DECLARE actual text;
BEGIN
 SELECT definition INTO actual FROM (SELECT pg_get_functiondef(p.oid) definition FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='valid_azure_browser_update_approval' AND pg_get_function_identity_arguments(p.oid)='agent jsonb, approval jsonb') observed;
 IF actual IS NULL THEN
  EXECUTE $object$CREATE OR REPLACE FUNCTION public.valid_azure_browser_update_approval(agent jsonb, approval jsonb)
 RETURNS boolean
 LANGUAGE plpgsql
 IMMUTABLE
 SET search_path TO 'public'
AS $function$
DECLARE plan jsonb:=approval->'browserPlan'; installed jsonb:=plan->'installation';
 metadata jsonb:=agent->'backend_metadata'; expected_release text; group_path text;
BEGIN
 IF jsonb_typeof(approval) IS DISTINCT FROM 'object' OR jsonb_typeof(plan) IS DISTINCT FROM 'object'
 OR jsonb_typeof(installed) IS DISTINCT FROM 'object' OR octet_length(approval::text)>65536
 OR approval->'version' IS DISTINCT FROM '2'::jsonb OR approval->>'capability' IS DISTINCT FROM 'browser'
 OR approval->'capabilityPlan' IS NOT NULL OR approval->'capabilityPlanDigest' IS NOT NULL
 OR agent->>'deployment_target' IS DISTINCT FROM 'user_azure' OR agent->>'backend' IS DISTINCT FROM 'user_azure'
 OR agent->>'status' IS DISTINCT FROM 'provisioned' OR metadata ? 'erasure'
 OR metadata ? 'hostKind' OR metadata ? 'vmHost'
 OR coalesce(agent->>'pod_pubkey','')='' OR coalesce(agent->>'pod_key_id','')=''
 OR nullif(agent->>'user_cloud_authorized_at','') IS NULL
 OR approval->>'ownerId' IS DISTINCT FROM agent->>'user_id'
 OR approval->>'hushhId' IS DISTINCT FROM agent->>'hushh_id'
 OR approval->>'podIncarnation' IS DISTINCT FROM metadata->>'serviceUid'
 OR plan->'version' IS DISTINCT FROM '2'::jsonb OR plan->>'capability' IS DISTINCT FROM 'browser'
 OR plan->>'hostKind' IS DISTINCT FROM 'azure_container_apps'
 OR plan->>'ownerId' IS DISTINCT FROM agent->>'user_id'
 OR plan->>'hushhId' IS DISTINCT FROM agent->>'hushh_id'
 OR plan->>'podKeyId' IS DISTINCT FROM agent->>'pod_key_id'
 OR plan->'placementEpoch' IS DISTINCT FROM agent->'placement_epoch'
 OR plan->>'serviceUid' IS DISTINCT FROM metadata->>'serviceUid'
 OR plan->>'targetImage' IS DISTINCT FROM approval->>'targetImage'
 OR coalesce(approval->>'targetImage','') !~ '^.+@sha256:[a-f0-9]{64}$'
 OR coalesce(approval->>'browserPlanDigest','') !~ '^[a-f0-9]{64}$'
 OR coalesce(plan->>'qualificationDigest','') !~ '^[a-f0-9]{64}$'
 OR jsonb_typeof(plan->'publicPolicy') IS DISTINCT FROM 'object'
 OR jsonb_typeof(plan->'resourceLimits') IS DISTINCT FROM 'object'
 OR installed->'version' IS DISTINCT FROM '2'::jsonb OR installed->>'capability' IS DISTINCT FROM 'files'
 OR installed->>'provider' IS DISTINCT FROM 'user_azure'
 OR installed->>'ownerId' IS DISTINCT FROM agent->>'user_id'
 OR installed->>'hushhId' IS DISTINCT FROM agent->>'hushh_id'
 OR installed->>'serviceUid' IS DISTINCT FROM metadata->>'serviceUid'
 OR installed->>'service' IS DISTINCT FROM agent->>'external_agent_id'
 OR installed->>'targetImage' IS DISTINCT FROM approval->>'targetImage'
 OR installed->>'tenantId' IS DISTINCT FROM agent->>'user_cloud_tenant_id'
 OR installed->>'subscriptionId' IS DISTINCT FROM agent->>'user_cloud_subscription_id'
 OR installed->>'resourceGroup' IS DISTINCT FROM agent->>'user_cloud_resource_group'
 OR installed->>'location' IS DISTINCT FROM agent->>'user_cloud_region'
 OR installed->>'setupNonce' IS DISTINCT FROM metadata->>'setupNonce'
 OR installed->>'principalId' IS DISTINCT FROM metadata->>'runtime_principal_id'
 OR installed->>'clientId' IS DISTINCT FROM metadata->>'runtime_client_id'
 OR coalesce(installed->>'templateDigest','') !~ '^[a-f0-9]{64}$'
 OR coalesce(installed->>'createdAt','')='' OR coalesce(installed->>'readyRevision','')=''
 THEN RETURN false; END IF;
 group_path:='/subscriptions/'||(agent->>'user_cloud_subscription_id')||'/resourceGroups/'||(agent->>'user_cloud_resource_group');
 IF installed->>'service' IS DISTINCT FROM group_path||'/providers/Microsoft.App/containerApps/ca-hussh-one-pod'
 OR installed->>'identityId' IS DISTINCT FROM group_path||'/providers/Microsoft.ManagedIdentity/userAssignedIdentities/id-hussh-one-pod'
 OR coalesce(installed->>'storageId','') !~ ('^'||group_path||'/providers/Microsoft.Storage/storageAccounts/sthussh[a-f0-9]{16}$')
 THEN RETURN false; END IF;
 expected_release:='rel_'||left(encode(sha256(convert_to(concat_ws('|',
  approval->>'hushhId',approval->>'podIncarnation',approval->>'targetImage',
  'browser.v1',approval->>'browserPlanDigest'),'UTF8')),'hex'),32);
 RETURN approval->>'releaseId'=expected_release;
END $function$
$object$;
 ELSIF encode(sha256(convert_to(actual,'UTF8')),'hex') NOT IN ('c573cd3cb58337076da95c2091fd4474ce3a8bdace9011ef9943b3cdf3d2b10d') THEN
  RAISE EXCEPTION 'Unqualified schema drift: valid_azure_browser_update_approval';
 END IF;
END
$object_guard$;

REVOKE ALL ON FUNCTION public."valid_azure_browser_update_approval"(jsonb, jsonb) FROM PUBLIC;

DO $pod_414$
BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN GRANT EXECUTE ON FUNCTION public."valid_azure_browser_update_approval"(jsonb, jsonb) TO service_role; END IF;
END
$pod_414$;

DO $object_guard$
DECLARE actual text;
BEGIN
 SELECT definition INTO actual FROM (SELECT pg_get_functiondef(p.oid) definition FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='valid_azure_cleanup_authorization_append' AND pg_get_function_identity_arguments(p.oid)='owner_id text, before_state jsonb, next_state jsonb') observed;
 IF actual IS NULL THEN
  EXECUTE $object$CREATE OR REPLACE FUNCTION public.valid_azure_cleanup_authorization_append(owner_id text, before_state jsonb, next_state jsonb)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public'
AS $function$
DECLARE item record; prior jsonb; incoming jsonb; auth jsonb; now_seconds bigint:=extract(epoch FROM statement_timestamp())::bigint;
BEGIN
 IF next_state-'authorizationAttempts' IS DISTINCT FROM before_state-'authorizationAttempts'
 OR jsonb_typeof(next_state->'authorizationAttempts') IS DISTINCT FROM 'object'
 OR (SELECT count(*) FROM jsonb_each(next_state->'authorizationAttempts'))>64 THEN RETURN false; END IF;
 FOR item IN SELECT * FROM jsonb_each(next_state->'authorizationAttempts') LOOP
  IF (next_state->'authorizationAttempts')-item.key IS DISTINCT FROM coalesce(before_state->'authorizationAttempts','{}'::jsonb)-item.key THEN CONTINUE; END IF;
  prior:=before_state->'authorizationAttempts'->item.key; incoming:=item.value;
  IF (item.key ~ '^[0-9a-f]{64}$') IS NOT TRUE OR jsonb_typeof(incoming) IS DISTINCT FROM 'object' THEN RETURN false; END IF;
  IF prior IS NULL THEN
   auth:=public.azure_erasure_authorization(owner_id,incoming->>'purpose');
   RETURN auth IS NOT NULL AND incoming=jsonb_build_object('purpose',auth->>'purpose',
    'digest',auth->>'digest','status','running','startedAt',now_seconds);
  END IF;
  RETURN prior->>'status'='running'
   AND incoming-ARRAY['status','finishedAt','code']=prior-'status'
   AND incoming->>'status' IN ('settled','attention_required')
   AND incoming->'finishedAt'=to_jsonb(now_seconds)
   AND (incoming->>'code' ~ '^[A-Z][A-Z0-9_]{0,95}$') IS TRUE;
 END LOOP;
 RETURN false;
END;
$function$
$object$;
 ELSIF encode(sha256(convert_to(actual,'UTF8')),'hex') NOT IN ('4c4e4537a15be8cb96d41c79b5b002e93b3f8d83f17cb9e0730743e604fd57db') THEN
  RAISE EXCEPTION 'Unqualified schema drift: valid_azure_cleanup_authorization_append';
 END IF;
END
$object_guard$;

REVOKE ALL ON FUNCTION public."valid_azure_cleanup_authorization_append"(text, jsonb, jsonb) FROM PUBLIC;

DO $pod_414$
BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN GRANT EXECUTE ON FUNCTION public."valid_azure_cleanup_authorization_append"(text, jsonb, jsonb) TO service_role; END IF;
END
$pod_414$;

DO $object_guard$
DECLARE actual text;
BEGIN
 SELECT definition INTO actual FROM (SELECT pg_get_functiondef(p.oid) definition FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='valid_azure_erasure_append' AND pg_get_function_identity_arguments(p.oid)='owner_id text, prior jsonb, incoming jsonb') observed;
 IF actual IS NULL THEN
  EXECUTE $object$CREATE OR REPLACE FUNCTION public.valid_azure_erasure_append(owner_id text, prior jsonb, incoming jsonb)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public'
AS $function$
DECLARE before_state jsonb:=coalesce(prior->'azureTeardown','{}'::jsonb);
 next_state jsonb:=incoming->'azureTeardown'; item record; old_resource jsonb; new_resource jsonb;
 approval jsonb; worker jsonb; stage text; receipt jsonb; definition jsonb; execution_id text;
BEGIN
 IF incoming-'azureTeardown' IS DISTINCT FROM prior-'azureTeardown'
 OR jsonb_typeof(next_state) IS DISTINCT FROM 'object'
 OR octet_length(next_state::text)>1048576
 OR next_state-ARRAY['plan','approvals','resources','worker','finalReadbacks','workerExits','setupHistory','authorizationAttempts']<>'{}'::jsonb THEN RETURN false; END IF;
 IF before_state='{}'::jsonb THEN
  RETURN next_state-ARRAY['plan','approvals','resources','setupHistory']='{}'::jsonb
   AND next_state->'setupHistory' IS NOT NULL
   AND next_state->'setupHistory'=public.azure_erasure_setup_history(owner_id)
   AND octet_length(next_state::text)<750000
   AND next_state->'approvals'='[]'::jsonb AND next_state->'resources'='{}'::jsonb
   AND public.valid_azure_erasure_plan(owner_id,next_state->'plan') IS TRUE;
 END IF;
 IF next_state->'setupHistory' IS DISTINCT FROM before_state->'setupHistory'
 OR next_state->'setupHistory' IS DISTINCT FROM public.azure_erasure_setup_history(owner_id)
 OR next_state->'plan' IS DISTINCT FROM before_state->'plan'
 OR public.valid_azure_erasure_plan(owner_id,next_state->'plan') IS NOT TRUE THEN RETURN false; END IF;
 IF public.valid_azure_cleanup_authorization_append(owner_id,before_state,next_state) IS TRUE THEN RETURN true; END IF;
 IF next_state-'approvals'=before_state-'approvals'
 AND jsonb_typeof(next_state->'approvals')='array'
 AND jsonb_array_length(next_state->'approvals')=jsonb_array_length(before_state->'approvals')+1
 AND (next_state->'approvals')-(jsonb_array_length(before_state->'approvals'))=before_state->'approvals'
 AND jsonb_array_length(next_state->'approvals')<=64 THEN
  approval:=(next_state->'approvals')->-1;
  RETURN approval-ARRAY['ownerId','attemptId','planDigest','issuedAt','expiresAt','scope','groupConfirmation']='{}'::jsonb
   AND approval->>'ownerId'=owner_id AND approval->>'attemptId'=prior->>'attemptId'
   AND approval->>'planDigest'=encode(sha256(convert_to((next_state->'plan')::text,'UTF8')),'hex')
   AND approval->>'scope'='exact_plan'
   AND approval->>'groupConfirmation'='/subscriptions/'||(next_state->'plan'->'context'->>'subscriptionId')||
     '/resourceGroups/'||(next_state->'plan'->'context'->>'resourceGroup')
   AND approval->'issuedAt'=to_jsonb(extract(epoch FROM statement_timestamp())::bigint)
   AND approval->'expiresAt'=to_jsonb(extract(epoch FROM statement_timestamp())::bigint+600);
 END IF;
 approval:=(before_state->'approvals')->-1;
 worker:=before_state->'worker'; execution_id:=worker->>'executionId';
 FOREACH stage IN ARRAY ARRAY['finalReadbacks','workerExits'] LOOP
  IF next_state-stage IS DISTINCT FROM before_state-stage THEN CONTINUE; END IF;
  IF public.byoc_azure_worker_session_held(owner_id) IS NOT TRUE
   OR worker->'backendPid' IS DISTINCT FROM to_jsonb(pg_backend_pid())
   OR jsonb_typeof(next_state->stage) IS DISTINCT FROM 'object'
   OR coalesce(before_state->stage,'{}'::jsonb) ? execution_id
   OR (next_state->stage)-execution_id IS DISTINCT FROM coalesce(before_state->stage,'{}'::jsonb)
   OR (SELECT count(*) FROM jsonb_each(next_state->stage))>128
   OR (before_state->'workerExits') ? execution_id THEN RETURN false; END IF;
  receipt:=(next_state->stage)->execution_id;
  RETURN receipt IS NOT NULL AND receipt=public.azure_erasure_execution_receipt(
    before_state,stage,receipt->>'outcome');
 END LOOP;
 IF next_state-'worker'=before_state-'worker' THEN
  worker:=next_state->'worker';
  RETURN public.byoc_azure_worker_session_held(owner_id) IS TRUE
   AND worker-ARRAY['executionId','backendPid','approvalIndex']='{}'::jsonb
   AND ((approval->>'expiresAt')::bigint>extract(epoch FROM statement_timestamp())) IS TRUE
   AND public.azure_erasure_writers_drained(owner_id) IS TRUE
   AND public.azure_cleanup_information_erased(owner_id,prior) IS TRUE
   AND octet_length(next_state::text)<900000
   AND (SELECT count(*) FROM jsonb_each(coalesce(before_state->'workerExits','{}'::jsonb)))<128
   AND (SELECT count(*) FROM jsonb_each(coalesce(before_state->'finalReadbacks','{}'::jsonb)))<128
   AND NOT (coalesce(before_state->'workerExits','{}'::jsonb) ? (worker->>'executionId'))
   AND NOT (coalesce(before_state->'finalReadbacks','{}'::jsonb) ? (worker->>'executionId'))
   AND (worker->>'executionId' ~ '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$') IS TRUE
   AND worker->'backendPid'=to_jsonb(pg_backend_pid())
   AND worker->'approvalIndex'=to_jsonb(jsonb_array_length(before_state->'approvals')-1)
   AND (before_state->'worker' IS NULL OR before_state->'worker'->'backendPid' IS DISTINCT FROM to_jsonb(pg_backend_pid()));
 END IF;
 worker:=before_state->'worker';
 IF next_state-'resources' IS DISTINCT FROM before_state-'resources'
 OR public.byoc_azure_worker_session_held(owner_id) IS NOT TRUE
 OR worker->'backendPid' IS DISTINCT FROM to_jsonb(pg_backend_pid())
 OR jsonb_typeof(next_state->'resources') IS DISTINCT FROM 'object' THEN RETURN false; END IF;
 FOR item IN SELECT * FROM jsonb_each(next_state->'resources') LOOP
  IF (next_state->'resources')-item.key IS DISTINCT FROM (before_state->'resources')-item.key THEN CONTINUE; END IF;
  definition:=next_state->'plan'->'resources'->item.key;
  IF definition IS NULL OR definition->'coveredBy'<>'null'::jsonb THEN RETURN false; END IF;
  old_resource:=coalesce(before_state->'resources'->item.key,'{}'::jsonb); new_resource:=item.value;
  IF new_resource-'providerHistory'=old_resource-ARRAY['providerHistory','provider_request','provider_ack','provider_terminal']
   AND NOT (coalesce(before_state->'finalReadbacks','{}'::jsonb) ? execution_id)
   AND NOT (coalesce(before_state->'workerExits','{}'::jsonb) ? execution_id)
   AND public.azure_erasure_request_retryable(old_resource) IS TRUE
   AND NOT old_resource ?| ARRAY['absence','acknowledgement']
   AND jsonb_typeof(new_resource->'providerHistory')='array'
   AND jsonb_array_length(new_resource->'providerHistory')<=8
   AND new_resource->'providerHistory'=coalesce(old_resource->'providerHistory','[]'::jsonb)||
     jsonb_build_array(old_resource-ARRAY['intent','providerHistory'])
   AND ((approval->>'expiresAt')::bigint>extract(epoch FROM statement_timestamp())) IS TRUE
   AND octet_length(next_state::text)<900000 THEN RETURN true; END IF;
  FOREACH stage IN ARRAY ARRAY['intent','provider_request','provider_ack','provider_terminal','acknowledgement','absence','retention'] LOOP
   IF old_resource ? stage OR new_resource-stage IS DISTINCT FROM old_resource THEN CONTINUE; END IF;
   IF stage IN ('intent','provider_request') AND (public.azure_erasure_writers_drained(owner_id) IS NOT TRUE
    OR coalesce(before_state->'finalReadbacks','{}'::jsonb) ? execution_id
    OR coalesce(before_state->'workerExits','{}'::jsonb) ? execution_id
    OR ((approval->>'expiresAt')::bigint>extract(epoch FROM statement_timestamp())) IS NOT TRUE) THEN RETURN false; END IF;
   receipt:=new_resource->stage;
   IF jsonb_typeof(receipt) IS DISTINCT FROM 'object' OR octet_length(receipt::text)>24576 THEN RETURN false; END IF;
   IF stage='intent' THEN
    RETURN definition->'identity'<>'null'::jsonb AND receipt=jsonb_build_object('identity',definition->'identity')
     AND octet_length(next_state::text)<900000;
   ELSIF stage='provider_request' THEN
    RETURN old_resource ? 'intent' AND receipt-ARRAY['requestId','method','path','apiVersion']='{}'::jsonb
     AND (receipt->>'requestId' ~ '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$') IS TRUE
     AND receipt->>'method'='DELETE' AND receipt->>'path'=item.key
     AND receipt->'apiVersion'=definition->'apiVersion' AND octet_length(next_state::text)<900000;
   ELSIF stage='provider_ack' THEN
    RETURN old_resource ? 'provider_request'
     AND receipt-ARRAY['requestId','status','operationUrl','operationUrlSha256','operationKind']='{}'::jsonb
     AND receipt->'requestId'=old_resource->'provider_request'->'requestId'
     AND public.valid_azure_arm_acknowledgement(receipt, '/subscriptions/'||
       (next_state->'plan'->'context'->>'subscriptionId')||'/resourceGroups/'||
       (next_state->'plan'->'context'->>'resourceGroup')) IS TRUE;
   ELSIF stage='provider_terminal' THEN
    RETURN old_resource ? 'provider_request' AND receipt-ARRAY['requestId','outcome']='{}'::jsonb
     AND receipt->'requestId'=old_resource->'provider_request'->'requestId'
     AND receipt->>'outcome' IN ('not_dispatched','refused','failed','succeeded')
     AND (receipt->>'outcome'='not_dispatched' OR old_resource ? 'provider_ack')
     AND (receipt->>'outcome'<>'succeeded' OR old_resource->'provider_ack'->>'status' IN ('200','201','202','204'));
   ELSIF stage='acknowledgement' THEN
    RETURN old_resource ? 'provider_request' AND public.azure_erasure_absence_settled(old_resource) IS TRUE
     AND receipt=jsonb_build_object('status','provider_completed','id',item.key);
   ELSIF stage='retention' THEN
    RETURN old_resource ? 'absence' AND public.valid_azure_retention_receipt(next_state->'plan',item.key,receipt) IS TRUE;
   ELSIF stage='absence' THEN
    RETURN public.azure_erasure_absence_settled(old_resource) IS TRUE
     AND receipt=jsonb_build_object('status','active_resource_absent','id',item.key);
   END IF;
  END LOOP;
 END LOOP;
 RETURN false;
EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN RETURN false;
END;
$function$
$object$;
 ELSIF encode(sha256(convert_to(actual,'UTF8')),'hex') NOT IN ('d15c69ec1be2deba4a1b31c13848958aebaf6398cfd1ae8891e77518e26d9e83') THEN
  RAISE EXCEPTION 'Unqualified schema drift: valid_azure_erasure_append';
 END IF;
END
$object_guard$;

REVOKE ALL ON FUNCTION public."valid_azure_erasure_append"(text, jsonb, jsonb) FROM PUBLIC;

DO $pod_414$
BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN GRANT EXECUTE ON FUNCTION public."valid_azure_erasure_append"(text, jsonb, jsonb) TO service_role; END IF;
END
$pod_414$;

DO $object_guard$
DECLARE actual text;
BEGIN
 SELECT definition INTO actual FROM (SELECT pg_get_functiondef(p.oid) definition FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='valid_azure_erasure_plan' AND pg_get_function_identity_arguments(p.oid)='owner_id text, plan jsonb') observed;
 IF actual IS NULL THEN
  EXECUTE $object$CREATE OR REPLACE FUNCTION public.valid_azure_erasure_plan(owner_id text, plan jsonb)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public'
AS $function$
DECLARE context jsonb:=public.azure_erasure_context(owner_id); group_path text;
 item record; resource jsonb;
BEGIN
 IF context IS NULL OR jsonb_typeof(plan) IS DISTINCT FROM 'object'
 OR plan-ARRAY['version','context','resources','termsVersion']<>'{}'::jsonb
 OR plan->'version' IS DISTINCT FROM '1'::jsonb OR plan->'context' IS DISTINCT FROM context
 OR coalesce(plan->>'termsVersion','') NOT IN ('azure-exact-parent-v1','azure-exact-parent-retention-v2')
 OR jsonb_typeof(plan->'resources') IS DISTINCT FROM 'object'
 OR (SELECT count(*) FROM jsonb_each(plan->'resources')) NOT BETWEEN 1 AND 128
 OR octet_length(plan::text)>262144 THEN RETURN false; END IF;
 group_path:='/subscriptions/'||(context->>'subscriptionId')||
   '/resourceGroups/'||(context->>'resourceGroup');
 IF context->'neverDeployed'='true'::jsonb AND (
  jsonb_typeof(plan->'resources'->(group_path||'/providers/Microsoft.App/containerApps/ca-hussh-one-pod')) IS DISTINCT FROM 'object'
  OR plan->'resources'->(group_path||'/providers/Microsoft.App/containerApps/ca-hussh-one-pod')->'identity' IS DISTINCT FROM 'null'::jsonb
  OR plan->'resources'->(group_path||'/providers/Microsoft.App/containerApps/ca-hussh-one-pod')->'coveredBy' IS DISTINCT FROM 'null'::jsonb
  OR (SELECT count(*) FROM jsonb_each(plan->'resources') x WHERE x.key ~* '/Microsoft[.]App/containerApps/[^/]+$')<>1
 ) THEN RETURN false; END IF;
 FOR item IN SELECT * FROM jsonb_each(plan->'resources') LOOP
  resource:=item.value;
  IF item.key !~ '^/subscriptions/[0-9a-f-]+/resourceGroups/[A-Za-z0-9_.()-]+'
  OR NOT (item.key=group_path OR starts_with(item.key,group_path||'/providers/'))
  OR jsonb_typeof(resource) IS DISTINCT FROM 'object'
  OR resource-ARRAY['apiVersion','kind','expected','coveredBy','identity','deletionScope']<>'{}'::jsonb
  OR (resource->>'apiVersion' ~ '^\d{4}-\d{2}-\d{2}(-preview)?$') IS NOT TRUE
  OR (resource->>'kind' IN ('resource','role_assignment','role_definition')) IS NOT TRUE
  OR jsonb_typeof(resource->'expected') IS DISTINCT FROM 'object'
  OR resource->>'deletionScope' IS DISTINCT FROM (CASE WHEN item.key=group_path THEN 'whole_group'
    WHEN resource->>'kind'='resource' THEN 'all_contents' ELSE 'resource_only' END)
  OR NOT resource ?& ARRAY['apiVersion','kind','expected','coveredBy','identity','deletionScope']
  THEN RETURN false; END IF;
  IF resource->'identity'<>'null'::jsonb AND (jsonb_typeof(resource->'identity') IS DISTINCT FROM 'object'
   OR lower(resource->'identity'->>'id') IS DISTINCT FROM lower(item.key)) THEN RETURN false; END IF;
  IF resource->'coveredBy'<>'null'::jsonb AND (jsonb_typeof(resource->'coveredBy') IS DISTINCT FROM 'string'
   OR NOT (plan->'resources' ? (resource->>'coveredBy'))
   OR NOT starts_with(item.key,(resource->>'coveredBy')||'/')) THEN RETURN false; END IF;
 END LOOP;
 RETURN true;
END;
$function$
$object$;
 ELSIF encode(sha256(convert_to(actual,'UTF8')),'hex') NOT IN ('129883dbea3bf4e660a4aaa595182a8b0f0c31e85fdc7d3cb0b368af7dfa5c6a') THEN
  RAISE EXCEPTION 'Unqualified schema drift: valid_azure_erasure_plan';
 END IF;
END
$object_guard$;

REVOKE ALL ON FUNCTION public."valid_azure_erasure_plan"(text, jsonb) FROM PUBLIC;

DO $pod_414$
BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN GRANT EXECUTE ON FUNCTION public."valid_azure_erasure_plan"(text, jsonb) TO service_role; END IF;
END
$pod_414$;

DO $object_guard$
DECLARE actual text;
BEGIN
 SELECT definition INTO actual FROM (SELECT pg_get_functiondef(p.oid) definition FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='valid_azure_retention_receipt' AND pg_get_function_identity_arguments(p.oid)='plan jsonb, resource_id text, receipt jsonb') observed;
 IF actual IS NULL THEN
  EXECUTE $object$CREATE OR REPLACE FUNCTION public.valid_azure_retention_receipt(plan jsonb, resource_id text, receipt jsonb)
 RETURNS boolean
 LANGUAGE plpgsql
 IMMUTABLE
 SET search_path TO 'public'
AS $function$
DECLARE context jsonb:=plan->'context'; base text; group_base text; name text; target text; kind text;
 api text; value text; deletion_time timestamptz; purge_time timestamptz;
BEGIN
 base:='/subscriptions/'||(context->>'subscriptionId')||'/providers/';
 name:=regexp_replace(resource_id,'^.*/','');
 group_base:='/subscriptions/'||(context->>'subscriptionId')||'/resourceGroups/'||(context->>'resourceGroup')||'/providers/';
 IF resource_id=group_base||'Microsoft.KeyVault/vaults/'||name THEN
  kind:='key_vault'; api:='2023-07-01'; target:=base||'Microsoft.KeyVault/locations/'||(context->>'location')||'/deletedVaults/'||name;
 ELSIF resource_id=group_base||'Microsoft.Storage/storageAccounts/'||name THEN
  kind:='storage'; api:='2023-05-01'; target:=base||'Microsoft.Storage/locations/'||(context->>'location')||'/deletedAccounts/'||name;
 ELSIF resource_id=group_base||'Microsoft.CognitiveServices/accounts/'||name THEN
  kind:='model_account'; api:='2024-10-01'; target:=base||'Microsoft.CognitiveServices/locations/'||(context->>'location')||'/resourceGroups/'||(context->>'resourceGroup')||'/deletedAccounts/'||name;
 ELSE RETURN false; END IF;
 IF NOT (plan->'resources' ? resource_id) OR plan->'resources'->resource_id->>'kind' IS DISTINCT FROM 'resource'
 OR plan->'resources'->resource_id->'coveredBy' IS DISTINCT FROM 'null'::jsonb
 OR jsonb_typeof(receipt) IS DISTINCT FROM 'object'
 OR receipt->>'id' IS DISTINCT FROM resource_id OR receipt->>'providerRecord' IS DISTINCT FROM target
 OR receipt->>'apiVersion' IS DISTINCT FROM api OR receipt->>'kind' IS DISTINCT FROM kind
 OR receipt->'physicalPurgeVerified' IS DISTINCT FROM 'false'::jsonb
 THEN RETURN false; END IF;
 IF receipt->>'status'='provider_record_absent' THEN
  RETURN receipt-ARRAY['id','providerRecord','apiVersion','kind','physicalPurgeVerified','status']='{}'::jsonb;
 END IF;
 IF receipt->>'status' IS DISTINCT FROM 'provider_retained' THEN RETURN false; END IF;
 IF kind='storage' THEN
  IF receipt-ARRAY['id','providerRecord','apiVersion','kind','physicalPurgeVerified','status','creationTime','deletionTime']<>'{}'::jsonb
   OR receipt->>'creationTime' IS DISTINCT FROM plan->'resources'->resource_id->'identity'->>'createdAt'
   OR jsonb_typeof(receipt->'creationTime') IS DISTINCT FROM 'string'
   OR jsonb_typeof(receipt->'deletionTime') IS DISTINCT FROM 'string' THEN RETURN false; END IF;
  RETURN (receipt->>'creationTime')::timestamptz<=(receipt->>'deletionTime')::timestamptz;
 END IF;
 IF receipt-ARRAY['id','providerRecord','apiVersion','kind','physicalPurgeVerified','status','deletionDate','scheduledPurgeDate','purgeProtectionEnabled']<>'{}'::jsonb
 OR jsonb_typeof(receipt->'deletionDate') IS DISTINCT FROM 'string'
 OR jsonb_typeof(receipt->'scheduledPurgeDate') IS DISTINCT FROM 'string'
 OR (kind='key_vault' AND jsonb_typeof(receipt->'purgeProtectionEnabled') IS DISTINCT FROM 'boolean')
 OR (kind='model_account' AND receipt ? 'purgeProtectionEnabled') THEN RETURN false; END IF;
 deletion_time:=(receipt->>'deletionDate')::timestamptz; purge_time:=(receipt->>'scheduledPurgeDate')::timestamptz;
 RETURN deletion_time<=purge_time;
EXCEPTION WHEN invalid_text_representation OR invalid_datetime_format OR datetime_field_overflow THEN RETURN false;
END;
$function$
$object$;
 ELSIF encode(sha256(convert_to(actual,'UTF8')),'hex') NOT IN ('ea952c16cf14867d68477f9b668ea9cfbd45d0d1d1f6c96d225352cb91f1d12b') THEN
  RAISE EXCEPTION 'Unqualified schema drift: valid_azure_retention_receipt';
 END IF;
END
$object_guard$;

REVOKE ALL ON FUNCTION public."valid_azure_retention_receipt"(jsonb, text, jsonb) FROM PUBLIC;

DO $pod_414$
BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN GRANT EXECUTE ON FUNCTION public."valid_azure_retention_receipt"(jsonb, text, jsonb) TO service_role; END IF;
END
$pod_414$;

DO $object_guard$
DECLARE actual text;
BEGIN
 SELECT definition INTO actual FROM (SELECT pg_get_functiondef(p.oid) definition FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='valid_azure_vm_power_event' AND pg_get_function_identity_arguments(p.oid)='state jsonb, event jsonb') observed;
 IF actual IS NULL THEN
  EXECUTE $object$CREATE OR REPLACE FUNCTION public.valid_azure_vm_power_event(state jsonb, event jsonb)
 RETURNS boolean
 LANGUAGE plpgsql
 IMMUTABLE
 SET search_path TO 'public'
AS $function$
DECLARE kind text:=event->>'kind'; events jsonb:=state->'events'; request jsonb;
 resource text:=state->'binding'->>'externalAgentId'; phase text:=state->>'phase';
BEGIN
 IF jsonb_typeof(event) IS DISTINCT FROM 'object' OR length(event::text)>8192
 THEN RETURN false; END IF;
 IF kind='drain' THEN
  RETURN coalesce(phase='preparing'
   AND event-ARRAY['kind','receipt']='{}'::jsonb
   AND (event->'receipt')-ARRAY['version','operationId','incarnation','runtimeEpoch','activeWork',
     'committedState','issuedAt','committedCursor','idleRecord']='{}'::jsonb
   AND event->'receipt'->'version'='1'::jsonb
   AND event->'receipt'->>'operationId'=state->>'operationId'
   AND event->'receipt'->>'incarnation'=state->'binding'->>'serviceUid'
   AND event->'receipt'->'activeWork'='0'::jsonb
   AND event->'receipt'->>'runtimeEpoch' ~ '^[A-Za-z0-9_-]+$'
   AND length(event->'receipt'->>'runtimeEpoch')<=256
   AND event->'receipt'->>'issuedAt' ~ '^[0-9T:.+Z-]{20,40}$'
   AND event->'receipt'->>'committedState' ~ '^[a-f0-9]{64}$'
   AND jsonb_typeof(event->'receipt'->'committedCursor'->'seq')='number'
   AND event->'receipt'->'committedCursor'->>'sha' ~ '^[a-f0-9]{64}$'
   AND jsonb_typeof(event->'receipt'->'idleRecord'->'seq')='number'
   AND event->'receipt'->'idleRecord'->>'sha' ~ '^[a-f0-9]{64}$'
   AND (event->'receipt'->'committedCursor')-ARRAY['seq','sha']='{}'::jsonb
   AND (event->'receipt'->'idleRecord')-ARRAY['seq','sha']='{}'::jsonb
   AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(events) e WHERE e->>'kind'='drain'),false);
 ELSIF kind='request' THEN
  RETURN coalesce(event-ARRAY['kind','requestId','method','path','apiVersion','purpose']='{}'::jsonb
   AND event->>'requestId' ~ '^[a-f0-9-]{36}$' AND event->>'method'='POST'
   AND event->>'apiVersion'='2024-03-01'
   AND ((phase='drained' AND event->>'path'=resource||'/deallocate'
     AND event->>'purpose'='vm_deallocate')
    OR (phase='starting' AND event->>'path'=resource||'/start' AND event->>'purpose'='vm_start'))
   -- Reserve the remaining acknowledgement, terminal and recovery events before
   -- dispatch. Nondispatch retries must not consume the last release slots.
   AND jsonb_array_length(events)+CASE WHEN phase='drained' THEN 10 ELSE 6 END<=16
   AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(events) e WHERE e->>'kind'='request'
     AND (e->>'requestId'=event->>'requestId' OR (e->>'purpose'=event->>'purpose'
       AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(events) terminal
         WHERE terminal->>'kind'='terminal' AND terminal->>'requestId'=e->>'requestId'
           AND terminal->>'outcome'='not_dispatched')))),false);
 ELSIF kind IN ('ack','terminal') THEN
  SELECT e INTO request FROM jsonb_array_elements(events) e
   WHERE e->>'kind'='request' AND e->>'requestId'=event->>'requestId';
  IF request IS NULL OR EXISTS(SELECT 1 FROM jsonb_array_elements(events) e
    WHERE e->>'kind'=kind AND e->>'requestId'=event->>'requestId') THEN RETURN false; END IF;
  IF kind='ack' THEN
   RETURN coalesce(event-ARRAY['kind','requestId','status','operationUrl','operationUrlSha256','operationKind']='{}'::jsonb
    AND public.valid_azure_arm_acknowledgement(event,request->>'path'),false);
  END IF;
  RETURN coalesce(event-ARRAY['kind','requestId','outcome']='{}'::jsonb
   AND event->>'outcome' IN ('succeeded','failed','refused','not_dispatched'),false);
 ELSIF kind='power' THEN
  RETURN coalesce(event-ARRAY['kind','resourceId','vmId','state']='{}'::jsonb
   AND event->>'resourceId'=resource
   AND event->>'vmId'=state->'binding'->'host'->'installation'->>'vm_id'
   AND ((phase='drained' AND event->>'state'='deallocated')
     OR (phase='starting' AND event->>'state'='running'))
   AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(events) e
     WHERE e->>'kind'='power' AND e->>'state'=event->>'state'),false);
 ELSIF kind='recovery' THEN
  RETURN coalesce(phase IN ('starting','recovered')
   AND event-ARRAY['kind','incarnation','podKeyId','imageDigest','retainedIdleRecord','runtimeEpoch']='{}'::jsonb
   AND event->>'incarnation'=state->'binding'->>'serviceUid'
   AND event->>'podKeyId'=state->'binding'->>'podKeyId'
   AND event->>'imageDigest'=state->'binding'->'host'->'installation'->>'image_digest'
   AND event->>'runtimeEpoch' ~ '^[A-Za-z0-9_-]+$'
   AND length(event->>'runtimeEpoch')<=256
   AND EXISTS(SELECT 1 FROM jsonb_array_elements(events) e WHERE e->>'kind'='drain'
     AND e->'receipt'->'idleRecord'=event->'retainedIdleRecord'
     AND e->'receipt'->>'runtimeEpoch'<>event->>'runtimeEpoch')
   AND jsonb_array_length(events)+2<=16
   AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(events) e WHERE e->>'kind'='released')
   AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(events) e WHERE e->>'kind'='recovery'
     AND e->>'runtimeEpoch'=event->>'runtimeEpoch'),false);
 ELSIF kind='released' THEN
  RETURN coalesce(phase='recovered'
   AND event-ARRAY['kind','operationId','incarnation','runtimeEpoch','releaseRecord']='{}'::jsonb
   AND event->>'operationId'=state->>'operationId'
   AND event->>'incarnation'=state->'binding'->>'serviceUid'
   AND jsonb_typeof(event->'releaseRecord'->'seq')='number'
   AND event->'releaseRecord'->>'sha' ~ '^[a-f0-9]{64}$'
   AND (event->'releaseRecord')-ARRAY['seq','sha']='{}'::jsonb
   AND event->>'runtimeEpoch'=(SELECT e->>'runtimeEpoch'
     FROM jsonb_array_elements(events) WITH ORDINALITY items(e,n)
     WHERE e->>'kind'='recovery' ORDER BY n DESC LIMIT 1)
   AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(events) e WHERE e->>'kind'='released'),false);
 END IF;
 RETURN false;
END;
$function$
$object$;
 ELSIF encode(sha256(convert_to(actual,'UTF8')),'hex') NOT IN ('b187f876a13940412b74b8aff645e1c0869bb21b81cd86e244acb901cbb29911') THEN
  RAISE EXCEPTION 'Unqualified schema drift: valid_azure_vm_power_event';
 END IF;
END
$object_guard$;

REVOKE ALL ON FUNCTION public."valid_azure_vm_power_event"(jsonb, jsonb) FROM PUBLIC;

DO $pod_414$
BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN GRANT EXECUTE ON FUNCTION public."valid_azure_vm_power_event"(jsonb, jsonb) TO service_role; END IF;
END
$pod_414$;

DO $object_guard$
DECLARE actual text;
BEGIN
 SELECT definition INTO actual FROM (SELECT pg_get_functiondef(p.oid) definition FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='valid_byoc_azure_hosted_intent' AND pg_get_function_identity_arguments(p.oid)='owner_id text, job_id text, target text, hushh_id text, intent jsonb') observed;
 IF actual IS NULL THEN
  EXECUTE $object$CREATE OR REPLACE FUNCTION public.valid_byoc_azure_hosted_intent(owner_id text, job_id text, target text, hushh_id text, intent jsonb)
 RETURNS boolean
 LANGUAGE plpgsql
 IMMUTABLE
 SET search_path TO 'public'
AS $function$
DECLARE extra text[]:=ARRAY['kind','binding','sourceImage','allowedRequests']; call jsonb;
BEGIN
 IF intent->>'kind' NOT IN ('upgrade','rebuild') THEN RETURN false; END IF;
 IF intent->>'kind'='upgrade' THEN
   extra:=extra||ARRAY['attemptId','operationId','releaseId','idempotencyKey','capabilityPlanDigest'];
   IF (intent->>'attemptId' ~ '^[a-f0-9]{64}$') IS NOT TRUE
    OR EXISTS(SELECT 1 FROM unnest(ARRAY['operationId','releaseId','idempotencyKey']) k
      WHERE jsonb_typeof(intent->k) IS DISTINCT FROM 'string' OR length(intent->>k) NOT BETWEEN 1 AND 256)
    OR NOT (intent->'capabilityPlanDigest'='null'::jsonb OR
      (intent->>'capabilityPlanDigest' ~ '^[a-f0-9]{64}$') IS TRUE)
   THEN RETURN false; END IF;
 END IF;
 IF public.valid_byoc_azure_setup_intent(owner_id,job_id,target,hushh_id,
    jsonb_set(intent-extra,'{version}','1'::jsonb)) IS NOT TRUE
  OR NOT intent ?& extra OR octet_length(intent::text)>32768
  OR jsonb_typeof(intent->'binding') IS DISTINCT FROM 'object'
  OR jsonb_typeof(intent->'sourceImage') IS DISTINCT FROM 'string'
  OR (intent->>'sourceImage' ~ '^[A-Za-z0-9./_:-]+@sha256:[a-f0-9]{64}$') IS NOT TRUE
  OR jsonb_typeof(intent->'allowedRequests') IS DISTINCT FROM 'array'
 THEN RETURN false; END IF;
 IF jsonb_array_length(intent->'allowedRequests') NOT BETWEEN 2 AND 64 THEN RETURN false; END IF;
 FOR call IN SELECT value FROM jsonb_array_elements(intent->'allowedRequests') LOOP
  IF call-ARRAY['method','path','apiVersion','purpose']<>'{}'::jsonb
   OR NOT call ?& ARRAY['method','path','apiVersion','purpose']
   OR (call->>'method' IN ('PUT','POST')) IS NOT TRUE
   OR (call->>'apiVersion' ~ '^\d{4}-\d{2}-\d{2}(-preview)?$') IS NOT TRUE
   OR (call->>'purpose' ~ '^[a-z_]{1,64}$') IS NOT TRUE
   OR length(call->>'path') NOT BETWEEN 1 AND 2048
   OR (call->>'path' ~ '^[A-Za-z0-9_./()@:-]+$') IS NOT TRUE
   OR position('..' IN call->>'path')>0
   OR public.valid_byoc_azure_hosted_request(intent,call,target) IS NOT TRUE
   OR NOT (starts_with(call->>'path',target||'/') OR
     (call->>'method'='POST' AND call->>'purpose'='registering_providers'
      AND call->>'path'=ANY(ARRAY(SELECT '/subscriptions/'||(intent->>'subscriptionId')||
       '/providers/'||provider||'/register' FROM unnest(ARRAY['Microsoft.App',
       'Microsoft.ManagedIdentity','Microsoft.KeyVault','Microsoft.Storage',
       'Microsoft.ContainerRegistry','Microsoft.CognitiveServices']) provider))))
  THEN RETURN false; END IF;
 END LOOP;
 RETURN true;
END $function$
$object$;
 ELSIF encode(sha256(convert_to(actual,'UTF8')),'hex') NOT IN ('ee797ffc43158af93e1cd71a2b4010edffbb8d7948fdf893a2ff2d0fa7e520c9') THEN
  RAISE EXCEPTION 'Unqualified schema drift: valid_byoc_azure_hosted_intent';
 END IF;
END
$object_guard$;

REVOKE ALL ON FUNCTION public."valid_byoc_azure_hosted_intent"(text, text, text, text, jsonb) FROM PUBLIC;

DO $pod_414$
BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN GRANT EXECUTE ON FUNCTION public."valid_byoc_azure_hosted_intent"(text, text, text, text, jsonb) TO service_role; END IF;
END
$pod_414$;

DO $object_guard$
DECLARE actual text;
BEGIN
 SELECT definition INTO actual FROM (SELECT pg_get_functiondef(p.oid) definition FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='valid_byoc_azure_hosted_request' AND pg_get_function_identity_arguments(p.oid)='intent jsonb, call jsonb, target text') observed;
 IF actual IS NULL THEN
  EXECUTE $object$CREATE OR REPLACE FUNCTION public.valid_byoc_azure_hosted_request(intent jsonb, call jsonb, target text)
 RETURNS boolean
 LANGUAGE plpgsql
 IMMUTABLE
 SET search_path TO 'public'
AS $function$
DECLARE digest text:=substring(intent->'binding'->>'image' FROM '^crhussh([a-f0-9]{16})\.azurecr\.io/');
 base text:=target||'/providers/'; path text:=call->>'path'; purpose text:=call->>'purpose';
 app text:=target||'/providers/Microsoft.App/containerApps/ca-hussh-one-pod'; registry text;
 roles text[]; scope text;
BEGIN
 IF digest IS NULL OR intent->'binding'->>'external_agent_id' IS DISTINCT FROM app
 THEN RETURN false; END IF;
 registry:=base||'Microsoft.ContainerRegistry/registries/crhussh'||digest;
 IF purpose='files_activation' THEN
  RETURN intent->>'kind'='upgrade' AND intent->'capabilityPlanDigest'<>'null'::jsonb
   AND call->>'method'='PUT' AND call->>'apiVersion' IN ('2023-05-01','2022-04-01');
 END IF;
 IF purpose='importing_image' THEN RETURN call->>'method'='POST'
  AND call->>'apiVersion'='2023-07-01' AND path=registry||'/importImage'; END IF;
 IF purpose='deploying_agent' AND path=app THEN RETURN call->>'method'='PUT'
  AND call->>'apiVersion'='2025-01-01'; END IF;
 IF intent->>'kind'<>'rebuild' THEN RETURN false; END IF;
 IF purpose='registering_providers' THEN RETURN call->>'method'='POST'
  AND call->>'apiVersion'='2021-04-01'
  AND path=ANY(ARRAY(SELECT '/subscriptions/'||(intent->>'subscriptionId')||'/providers/'||p||'/register'
    FROM unnest(ARRAY['Microsoft.App','Microsoft.ManagedIdentity','Microsoft.KeyVault',
     'Microsoft.Storage','Microsoft.ContainerRegistry','Microsoft.CognitiveServices']) p)); END IF;
 IF call->>'method'<>'PUT' THEN RETURN false; END IF;
 IF purpose='creating_registry' THEN RETURN path=registry AND call->>'apiVersion'='2023-07-01'; END IF;
 IF purpose='creating_model' THEN RETURN call->>'apiVersion'='2024-10-01' AND path IN (
  base||'Microsoft.CognitiveServices/accounts/oai-hussh-'||digest,
  base||'Microsoft.CognitiveServices/accounts/oai-hussh-'||digest||'/deployments/one-chat'); END IF;
 IF purpose='creating_environment' THEN RETURN path=base||'Microsoft.App/managedEnvironments/cae-hussh-one'
  AND call->>'apiVersion'='2025-01-01'; END IF;
 IF purpose NOT IN ('assigning_roles','deploying_agent') OR call->>'apiVersion'<>'2022-04-01'
 THEN RETURN false; END IF;
 IF purpose='assigning_roles' AND starts_with(path,base||'Microsoft.Authorization/roleDefinitions/')
 THEN RETURN substring(path FROM length(base||'Microsoft.Authorization/roleDefinitions/')+1)
   ~ '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$'; END IF;
 roles:=ARRAY[target,app,base||'Microsoft.App/managedEnvironments/cae-hussh-one',registry,
  base||'Microsoft.CognitiveServices/accounts/oai-hussh-'||digest,
  base||'Microsoft.KeyVault/vaults/kv-h1-'||digest||'/keys/pod-log-key',
  base||'Microsoft.KeyVault/vaults/kv-h1-'||digest||'/secrets/pod-signing-key',
  base||'Microsoft.Storage/storageAccounts/sthussh'||digest,
  base||'Microsoft.Storage/storageAccounts/sthussh'||digest||'/blobServices/default/containers/pod',
  base||'Microsoft.Storage/storageAccounts/sthussh'||digest||'/queueServices/default/queues/files-organization'];
 FOREACH scope IN ARRAY roles LOOP
  IF purpose='deploying_agent' AND scope<>app THEN CONTINUE; END IF;
  IF starts_with(path,scope||'/providers/Microsoft.Authorization/roleAssignments/') AND
    substring(path FROM length(scope||'/providers/Microsoft.Authorization/roleAssignments/')+1)
     ~ '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$' THEN RETURN true; END IF;
 END LOOP;
 RETURN false;
END $function$
$object$;
 ELSIF encode(sha256(convert_to(actual,'UTF8')),'hex') NOT IN ('25a5ee11dafc25255d1ca7843c13adf7a4f4b481e5934d98f622e23815040aed') THEN
  RAISE EXCEPTION 'Unqualified schema drift: valid_byoc_azure_hosted_request';
 END IF;
END
$object_guard$;

REVOKE ALL ON FUNCTION public."valid_byoc_azure_hosted_request"(jsonb, jsonb, text) FROM PUBLIC;

DO $pod_414$
BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN GRANT EXECUTE ON FUNCTION public."valid_byoc_azure_hosted_request"(jsonb, jsonb, text) TO service_role; END IF;
END
$pod_414$;

DO $object_guard$
DECLARE actual text;
BEGIN
 SELECT definition INTO actual FROM (SELECT pg_get_functiondef(p.oid) definition FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='valid_byoc_azure_setup_intent' AND pg_get_function_identity_arguments(p.oid)='owner_id text, job_id text, target text, hushh_id text, intent jsonb') observed;
 IF actual IS NULL THEN
  EXECUTE $object$CREATE OR REPLACE FUNCTION public.valid_byoc_azure_setup_intent(owner_id text, job_id text, target text, hushh_id text, intent jsonb)
 RETURNS boolean
 LANGUAGE plpgsql
 IMMUTABLE
 SET search_path TO 'public'
AS $function$
BEGIN
 IF intent->'version'='3'::jsonb THEN
  RETURN public.valid_byoc_azure_vm_upgrade_intent(owner_id,job_id,target,hushh_id,intent);
 END IF;
 IF intent->'version'='2'::jsonb THEN
   RETURN public.valid_byoc_azure_hosted_intent(owner_id,job_id,target,hushh_id,intent);
 END IF;
 IF jsonb_typeof(intent) IS DISTINCT FROM 'object' THEN RETURN false; END IF;
 IF EXISTS (SELECT 1 FROM unnest(ARRAY['jobId','hushhId','tenantId','subscriptionId',
   'resourceGroup','location','setupNonce']) field
   WHERE jsonb_typeof(intent->field) IS DISTINCT FROM 'string') THEN RETURN false; END IF;
 RETURN intent - ARRAY['version','jobId','hushhId','tenantId','subscriptionId',
   'resourceGroup','location','setupNonce','groupInitiallyAbsent'] = '{}'::jsonb
 AND intent ?& ARRAY['version','jobId','hushhId','tenantId','subscriptionId',
   'resourceGroup','location','setupNonce']
 AND (NOT intent ? 'groupInitiallyAbsent' OR jsonb_typeof(intent->'groupInitiallyAbsent')='boolean')
 AND intent->'version' = '1'::jsonb
 AND coalesce(owner_id,'') <> '' AND coalesce(job_id,'') <> ''
 AND intent->>'jobId' = job_id AND intent->>'hushhId' = hushh_id
 AND (intent->>'tenantId' ~ '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$') IS TRUE
 AND (intent->>'subscriptionId' ~ '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$') IS TRUE
 AND (intent->>'resourceGroup' ~ '^[A-Za-z0-9_().-]{0,89}[A-Za-z0-9_()-]$') IS TRUE
 AND (intent->>'location' ~ '^[a-z][a-z0-9]{1,39}$') IS TRUE
 AND (intent->>'setupNonce' ~ '^[0-9a-f]{16}$') IS TRUE
 AND target = '/subscriptions/' || (intent->>'subscriptionId') ||
   '/resourceGroups/' || (intent->>'resourceGroup')
 AND pg_column_size(intent) <= 4096;
END;
$function$
$object$;
 ELSIF encode(sha256(convert_to(actual,'UTF8')),'hex') NOT IN ('719d7d0bf4484d974d0a850dae6327a23f13ec31e7a5f197ae0b8d0e11644634') THEN
  RAISE EXCEPTION 'Unqualified schema drift: valid_byoc_azure_setup_intent';
 END IF;
END
$object_guard$;

REVOKE ALL ON FUNCTION public."valid_byoc_azure_setup_intent"(text, text, text, text, jsonb) FROM PUBLIC;

DO $pod_414$
BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN GRANT EXECUTE ON FUNCTION public."valid_byoc_azure_setup_intent"(text, text, text, text, jsonb) TO service_role; END IF;
END
$pod_414$;

DO $object_guard$
DECLARE actual text;
BEGIN
 SELECT definition INTO actual FROM (SELECT pg_get_functiondef(p.oid) definition FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='valid_byoc_azure_vm_upgrade_intent' AND pg_get_function_identity_arguments(p.oid)='owner_id text, job_id text, target text, hushh_id text, intent jsonb') observed;
 IF actual IS NULL THEN
  EXECUTE $object$CREATE OR REPLACE FUNCTION public.valid_byoc_azure_vm_upgrade_intent(owner_id text, job_id text, target text, hushh_id text, intent jsonb)
 RETURNS boolean
 LANGUAGE plpgsql
 IMMUTABLE
 SET search_path TO 'public'
AS $function$
DECLARE extra text[]:=ARRAY['kind','binding','sourceImage','allowedRequests','attemptId',
 'operationId','releaseId','idempotencyKey','capabilityPlanDigest','idleRecord','hostRequestSha256'];
 binding jsonb:=intent->'binding'; host jsonb:=binding->'vmHost';
 vm text:=host->'installation'->>'resource_id'; registry text; call jsonb; expected jsonb;
BEGIN
 IF jsonb_typeof(intent) IS DISTINCT FROM 'object' THEN RETURN false; END IF;
 IF intent->'version' IS DISTINCT FROM '3'::jsonb OR intent->>'kind' IS DISTINCT FROM 'vm_upgrade'
 OR intent->'capabilityPlanDigest' IS DISTINCT FROM 'null'::jsonb
 OR public.valid_byoc_azure_setup_intent(owner_id,job_id,target,hushh_id,
   jsonb_set(intent-extra,'{version}','1'::jsonb)) IS NOT TRUE
 OR NOT intent ?& extra OR octet_length(intent::text)>32768
 OR jsonb_typeof(binding) IS DISTINCT FROM 'object'
 OR binding->>'hostKind' IS DISTINCT FROM 'azure_vm'
 OR starts_with(vm,target||'/providers/Microsoft.Compute/virtualMachines/') IS NOT TRUE
 OR (substring(vm FROM length(target||'/providers/Microsoft.Compute/virtualMachines/')+1)
   ~ '^[A-Za-z0-9_-]{1,64}$') IS NOT TRUE
 OR binding->>'external_agent_id' IS DISTINCT FROM vm
 OR host->'installation'->>'hushh_id' IS DISTINCT FROM hushh_id
 OR host->'installation'->>'generation' IS DISTINCT FROM binding->>'serviceUid'
 OR binding->>'image_digest' IS DISTINCT FROM host->'installation'->>'image_digest'
 OR (binding->>'image' ~ '^[a-z0-9]{5,50}[.]azurecr[.]io/pod@sha256:[a-f0-9]{64}$') IS NOT TRUE
 OR right(binding->>'image',71) IS DISTINCT FROM binding->>'image_digest'
 OR (intent->>'sourceImage' ~ '^[A-Za-z0-9./_:-]+@sha256:[a-f0-9]{64}$') IS NOT TRUE
 OR (intent->>'attemptId' ~ '^[a-f0-9]{64}$') IS NOT TRUE
 OR EXISTS(SELECT 1 FROM unnest(ARRAY['operationId','releaseId','idempotencyKey']) k
   WHERE jsonb_typeof(intent->k) IS DISTINCT FROM 'string' OR length(intent->>k) NOT BETWEEN 1 AND 256)
 OR (intent->>'hostRequestSha256' ~ '^[a-f0-9]{64}$') IS NOT TRUE
 OR public.valid_pod_upgrade_cursor(intent->'idleRecord') IS NOT TRUE
 OR EXISTS(SELECT 1 FROM unnest(ARRAY['vmConfigurationSha256','vmUpdateModuleSha256']) k
   WHERE (binding->>k ~ '^[a-f0-9]{64}$') IS NOT TRUE)
 OR jsonb_typeof(intent->'allowedRequests') IS DISTINCT FROM 'array'
 THEN RETURN false; END IF;
 IF jsonb_array_length(intent->'allowedRequests')<>3 THEN RETURN false; END IF;
 registry:=target||'/providers/Microsoft.ContainerRegistry/registries/'||split_part(binding->>'image','.',1);
 FOR n IN 0..2 LOOP
  call:=intent->'allowedRequests'->n;
  IF jsonb_typeof(call) IS DISTINCT FROM 'object' THEN RETURN false; END IF;
  expected:=CASE n
   WHEN 0 THEN jsonb_build_object('method','POST','path',registry||'/importImage',
     'apiVersion','2023-07-01','purpose','vm_image_import')
   WHEN 1 THEN jsonb_build_object('method','POST','path',vm||'/runCommand',
     'apiVersion','2024-03-01','purpose','vm_image_replace')
   ELSE jsonb_build_object('method','PATCH','path',vm||'/providers/Microsoft.Resources/tags/default',
     'apiVersion','2021-04-01','purpose','vm_image_tag') END;
  IF call-'bodySha256' IS DISTINCT FROM expected
   OR jsonb_typeof(call->'bodySha256') IS DISTINCT FROM 'string'
   OR (call->>'bodySha256' ~ '^[a-f0-9]{64}$') IS NOT TRUE THEN RETURN false; END IF;
 END LOOP;
 RETURN true;
END;
$function$
$object$;
 ELSIF encode(sha256(convert_to(actual,'UTF8')),'hex') NOT IN ('cd719c2654e6cf670c8987fee62d676f0dbe4a28c46966b5b6c2d3056cfdf273') THEN
  RAISE EXCEPTION 'Unqualified schema drift: valid_byoc_azure_vm_upgrade_intent';
 END IF;
END
$object_guard$;

REVOKE ALL ON FUNCTION public."valid_byoc_azure_vm_upgrade_intent"(text, text, text, text, jsonb) FROM PUBLIC;

DO $pod_414$
BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN GRANT EXECUTE ON FUNCTION public."valid_byoc_azure_vm_upgrade_intent"(text, text, text, text, jsonb) TO service_role; END IF;
END
$pod_414$;

DO $object_guard$
DECLARE actual text;
BEGIN
 SELECT definition INTO actual FROM (SELECT pg_get_functiondef(p.oid) definition FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='valid_byoc_azure_worker_event' AND pg_get_function_identity_arguments(p.oid)='owner_id text, expected_job text, event jsonb, history jsonb, target text, hushh_id text') observed;
 IF actual IS NULL THEN
  EXECUTE $object$CREATE OR REPLACE FUNCTION public.valid_byoc_azure_worker_event(owner_id text, expected_job text, event jsonb, history jsonb, target text, hushh_id text)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public'
AS $function$
DECLARE kind text:=event->>'stage'; worker jsonb; request jsonb; acknowledgement jsonb;
 intent jsonb; request_id text:=event->>'requestId';
BEGIN
 IF jsonb_typeof(event) IS DISTINCT FROM 'object' OR octet_length(event::text)>24576
 OR jsonb_typeof(event->'jobId') IS DISTINCT FROM 'string'
 OR length(expected_job) NOT BETWEEN 1 AND 128
 OR (target ~ '^/subscriptions/[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}/resourceGroups/[A-Za-z0-9_().-]{0,89}[A-Za-z0-9_()-]$') IS NOT TRUE
 OR event->>'jobId' IS DISTINCT FROM expected_job
 OR (event->>'executionId' ~ '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$') IS NOT TRUE
 OR public.byoc_azure_worker_session_held(owner_id) IS NOT TRUE THEN RETURN false; END IF;
 SELECT x INTO worker FROM jsonb_array_elements(history) x
 WHERE x->>'stage'='azure_worker_started' AND x->>'executionId'=event->>'executionId';
 IF kind IN ('azure_worker_started','azure_provider_request') AND
   public.byoc_azure_live_worker_admitted(owner_id,expected_job,kind='azure_worker_started') IS NOT TRUE
 THEN RETURN false; END IF;
 IF kind='azure_worker_started' THEN
   RETURN worker IS NULL AND event-ARRAY['stage','jobId','executionId','backendPid']='{}'::jsonb
    AND event->'backendPid'=to_jsonb(pg_backend_pid())
    AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(history) pending_request
      WHERE pending_request->>'stage'='azure_provider_request' AND NOT EXISTS (
       SELECT 1 FROM jsonb_array_elements(history) terminal
       WHERE terminal->>'stage'='azure_provider_terminal'
       AND terminal->>'requestId'=pending_request->>'requestId'))
    AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(history) started
      WHERE started->>'stage'='azure_worker_started' AND NOT EXISTS (
       SELECT 1 FROM jsonb_array_elements(history) ended WHERE ended->>'stage'='azure_worker_exited'
       AND ended->>'executionId'=started->>'executionId'));
 END IF;
 IF worker IS NULL OR worker->>'jobId' IS DISTINCT FROM expected_job
 OR worker->'backendPid' IS DISTINCT FROM to_jsonb(pg_backend_pid())
 OR EXISTS (SELECT 1 FROM jsonb_array_elements(history) ended
   WHERE ended->>'stage'='azure_worker_exited' AND ended->>'executionId'=event->>'executionId')
 THEN RETURN false; END IF;
 IF kind='azure_worker_exited' THEN
   RETURN event-ARRAY['stage','jobId','executionId']='{}'::jsonb;
 END IF;
 IF (request_id ~ '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$') IS NOT TRUE
 THEN RETURN false; END IF;
 SELECT x INTO request FROM jsonb_array_elements(history) x
 WHERE x->>'stage'='azure_provider_request' AND x->>'requestId'=request_id;
 IF kind='azure_provider_request' THEN
   SELECT x->'intent' INTO intent FROM jsonb_array_elements(history) x
     WHERE x->>'stage'='azure_setup_intent';
   RETURN request IS NULL AND public.valid_byoc_azure_setup_intent(
      owner_id,expected_job,target,hushh_id,intent) IS TRUE
    AND event-(ARRAY['stage','jobId','executionId','requestId','method','path','apiVersion','purpose']||
      CASE WHEN intent->'version'='3'::jsonb THEN ARRAY['bodySha256'] ELSE ARRAY[]::text[] END)='{}'::jsonb
    AND (event->>'method' IN ('PUT','POST') OR (intent->'version'='3'::jsonb AND event->>'method'='PATCH'))
    AND (event->>'apiVersion' ~ '^\d{4}-\d{2}-\d{2}(-preview)?$') IS TRUE
    AND ((intent->'version'='3'::jsonb AND public.byoc_azure_vm_upgrade_request_ready(intent,event,history))
     OR (intent->'version'='2'::jsonb AND EXISTS (
      SELECT 1 FROM jsonb_array_elements(intent->'allowedRequests') call
      WHERE call=event-ARRAY['stage','jobId','executionId','requestId']))
     OR (intent->'version'='1'::jsonb AND event->>'purpose' IN (
      'creating_resource_group','registering_providers','creating_identity','creating_key_vault',
      'creating_storage','creating_registry','creating_model','creating_environment',
      'assigning_roles','importing_image','deploying_agent')))
    AND (event->>'purpose'<>'files_activation' OR
      public.byoc_azure_files_request_admitted(owner_id,event) IS TRUE)
    AND length(event->>'path') BETWEEN 1 AND 2048
    AND (event->>'path' ~ '^[A-Za-z0-9_./()@:-]+$') IS TRUE
    AND position('..' IN event->>'path')=0
    AND (event->>'path'=target OR starts_with(event->>'path',target||'/')
      OR (event->>'method'='POST' AND event->>'purpose'='registering_providers'
       AND event->>'path'=ANY(ARRAY(
        SELECT '/subscriptions/'||(intent->>'subscriptionId')||'/providers/'||p||'/register'
        FROM unnest(ARRAY['Microsoft.App','Microsoft.ManagedIdentity','Microsoft.KeyVault',
         'Microsoft.Storage','Microsoft.ContainerRegistry','Microsoft.CognitiveServices']) p))));
 END IF;
 IF request IS NULL OR request->>'executionId' IS DISTINCT FROM event->>'executionId'
 OR request->>'jobId' IS DISTINCT FROM expected_job THEN RETURN false; END IF;
 IF EXISTS (SELECT 1 FROM jsonb_array_elements(history) x
  WHERE x->>'stage'='azure_provider_terminal' AND x->>'requestId'=request_id)
 THEN RETURN false; END IF;
 SELECT x INTO acknowledgement FROM jsonb_array_elements(history) x
 WHERE x->>'stage'='azure_provider_ack' AND x->>'requestId'=request_id;
 IF kind='azure_provider_ack' THEN
   RETURN acknowledgement IS NULL
    AND event-ARRAY['stage','jobId','executionId','requestId','status','operationUrl','operationUrlSha256','operationKind']='{}'::jsonb
    AND public.valid_azure_arm_acknowledgement(event,target) IS TRUE;
 END IF;
 IF kind='azure_provider_terminal' THEN
   RETURN event-ARRAY['stage','jobId','executionId','requestId','outcome']='{}'::jsonb
    AND ((event->>'outcome'='not_dispatched' AND acknowledgement IS NULL)
     OR (event->>'outcome'='refused' AND acknowledgement->>'status'=ANY(
       ARRAY['400','401','403','404','405','409','412','422','429']))
     OR (event->>'outcome' IN ('succeeded','failed') AND
       (acknowledgement->>'status' ~ '^2[0-9]{2}$') IS TRUE));
 END IF;
 RETURN false;
END;
$function$
$object$;
 ELSIF encode(sha256(convert_to(actual,'UTF8')),'hex') NOT IN ('95233dcf09e1b7a056cf3d846beb562e157ebf5be907ba33592e96cd45654cb4') THEN
  RAISE EXCEPTION 'Unqualified schema drift: valid_byoc_azure_worker_event';
 END IF;
END
$object_guard$;

REVOKE ALL ON FUNCTION public."valid_byoc_azure_worker_event"(text, text, jsonb, jsonb, text, text) FROM PUBLIC;

DO $pod_414$
BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN GRANT EXECUTE ON FUNCTION public."valid_byoc_azure_worker_event"(text, text, jsonb, jsonb, text, text) TO service_role; END IF;
END
$pod_414$;

DO $object_guard$
DECLARE actual text;
BEGIN
 SELECT definition INTO actual FROM (SELECT pg_get_functiondef(p.oid) definition FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='valid_erasure_account_append' AND pg_get_function_identity_arguments(p.oid)='old_r jsonb, new_r jsonb') observed;
 IF actual IS NULL THEN
  EXECUTE $object$CREATE OR REPLACE FUNCTION public.valid_erasure_account_append(old_r jsonb, new_r jsonb)
 RETURNS boolean
 LANGUAGE plpgsql
 IMMUTABLE
 SET search_path TO 'public'
AS $function$
DECLARE old_s jsonb; new_s jsonb; stage text;
BEGIN
 old_s:=coalesce(old_r->'accountErasure','{}'::jsonb); new_s:=new_r->'accountErasure';
 IF new_r - 'accountErasure' IS DISTINCT FROM old_r - 'accountErasure' OR jsonb_typeof(new_s) IS DISTINCT FROM 'object' THEN RETURN false; END IF;
 FOREACH stage IN ARRAY ARRAY['admission','acknowledgement','deletion'] LOOP
  IF NOT (old_s ? stage) AND new_s - stage=old_s AND public.valid_erasure_account_receipt(old_r,stage,new_s->stage) IS TRUE THEN RETURN true; END IF;
 END LOOP;
 RETURN false;
END;
$function$
$object$;
 ELSIF encode(sha256(convert_to(actual,'UTF8')),'hex') NOT IN ('4c23911f48a9206f0842ec2d668ae938406acff54d5a8599f150820441cf9111') THEN
  RAISE EXCEPTION 'Unqualified schema drift: valid_erasure_account_append';
 END IF;
END
$object_guard$;

REVOKE ALL ON FUNCTION public."valid_erasure_account_append"(jsonb, jsonb) FROM PUBLIC;

DO $pod_414$
BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN GRANT EXECUTE ON FUNCTION public."valid_erasure_account_append"(jsonb, jsonb) TO service_role; END IF;
END
$pod_414$;

DO $object_guard$
DECLARE actual text;
BEGIN
 SELECT definition INTO actual FROM (SELECT pg_get_functiondef(p.oid) definition FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='valid_erasure_account_receipt' AND pg_get_function_identity_arguments(p.oid)='r jsonb, stage text, receipt jsonb') observed;
 IF actual IS NULL THEN
  EXECUTE $object$CREATE OR REPLACE FUNCTION public.valid_erasure_account_receipt(r jsonb, stage text, receipt jsonb)
 RETURNS boolean
 LANGUAGE plpgsql
 IMMUTABLE
 SET search_path TO 'public'
AS $function$
DECLARE obs jsonb; inv jsonb; admitted jsonb;
BEGIN
 IF stage IS NULL OR stage NOT IN ('admission','acknowledgement','deletion')
 OR jsonb_typeof(receipt) IS DISTINCT FROM 'object'
 OR public.valid_erasure_secret_receipt(r,'deletion',r->'secretErasure'->'deletion') IS DISTINCT FROM true THEN RETURN false; END IF;
 obs:=receipt->'resourceObservation'; inv:=r->'substrateInventory';
 IF receipt - ARRAY['ownerId','attemptId','resourceObservation','status'] <> '{}'::jsonb
 OR receipt->>'ownerId' IS DISTINCT FROM r->>'ownerId' OR receipt->>'attemptId' IS DISTINCT FROM r->>'attemptId'
 OR jsonb_typeof(obs) IS DISTINCT FROM 'object' OR obs - ARRAY['type','id','disposition','identity'] <> '{}'::jsonb
 OR obs->>'type' IS DISTINCT FROM 'service_account' OR obs->>'disposition' IS DISTINCT FROM 'created'
 OR obs->>'id' IS DISTINCT FROM r->'writerDisabled'->'runtimeIdentity'->>'email'
 OR obs->'identity' IS DISTINCT FROM r->'writerDisabled'->'runtimeIdentity'
 OR EXISTS (SELECT 1 FROM jsonb_array_elements(inv->'plannedResources') x WHERE x->>'type'='service_account' AND x->>'id'<>obs->>'id'
   AND (x->>'id' IS DISTINCT FROM r->'filesErasure'->'worker'->'deletion'->'resourceObservation'->>'id'
     OR public.valid_erasure_files_receipt(r,'worker','deletion',r->'filesErasure'->'worker'->'deletion') IS DISTINCT FROM true))
 OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(inv->'plannedResources') x WHERE x->>'type'='service_account' AND x->>'id'=obs->>'id')
 OR (SELECT count(*) FROM jsonb_array_elements(inv->'resourceObservations') x WHERE x=obs) <> 1 THEN RETURN false; END IF;
 IF stage='admission' THEN RETURN receipt->>'status'='admitted'; END IF;
 admitted:=r->'accountErasure'->'admission';
 IF jsonb_typeof(admitted) IS DISTINCT FROM 'object' THEN RETURN false; END IF;
 IF admitted->>'status' IS DISTINCT FROM 'admitted' OR receipt - 'status' IS DISTINCT FROM admitted - 'status' THEN RETURN false; END IF;
 IF stage='acknowledgement' THEN RETURN receipt->>'status'='acknowledged'; END IF;
 admitted:=r->'accountErasure'->'acknowledgement';
 IF jsonb_typeof(admitted) IS DISTINCT FROM 'object' THEN RETURN false; END IF;
 RETURN receipt->>'status'='absent' AND admitted->>'status' IS NOT DISTINCT FROM 'acknowledged'
   AND receipt - 'status' IS NOT DISTINCT FROM admitted - 'status';
END;
$function$
$object$;
 ELSIF encode(sha256(convert_to(actual,'UTF8')),'hex') NOT IN ('68e280acfaf4008a7a876f76f635092276abac5245428db0d8e50284b2eb8ed8') THEN
  RAISE EXCEPTION 'Unqualified schema drift: valid_erasure_account_receipt';
 END IF;
END
$object_guard$;

REVOKE ALL ON FUNCTION public."valid_erasure_account_receipt"(jsonb, text, jsonb) FROM PUBLIC;

DO $pod_414$
BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN GRANT EXECUTE ON FUNCTION public."valid_erasure_account_receipt"(jsonb, text, jsonb) TO service_role; END IF;
END
$pod_414$;

DO $object_guard$
DECLARE actual text;
BEGIN
 SELECT definition INTO actual FROM (SELECT pg_get_functiondef(p.oid) definition FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='valid_erasure_azure_files_upgrade_observation' AND pg_get_function_identity_arguments(p.oid)='r jsonb, observation jsonb') observed;
 IF actual IS NULL THEN
  EXECUTE $object$CREATE OR REPLACE FUNCTION public.valid_erasure_azure_files_upgrade_observation(r jsonb, observation jsonb)
 RETURNS boolean
 LANGUAGE plpgsql
 IMMUTABLE
 SET search_path TO 'public'
AS $function$
DECLARE snapshot jsonb:=r->'registrySnapshot'; metadata jsonb:=snapshot->'backend_metadata';
 approval jsonb:=metadata->'upgradeApproval'; plan jsonb:=approval->'capabilityPlan';
 intent jsonb:=metadata->'filesUpgradeCheckpoint'; prefix jsonb:=intent->'completed';
 inventory jsonb:=metadata->'azureFilesInventory'; calls jsonb:=inventory->'plannedOperations';
 completed jsonb:=observation->'completed'; result jsonb; call jsonb; props jsonb; i int;
 group_path text; storage_path text; queue_path text; role_path text;
 steps text[]:=ARRAY['files_queue','files_custody_role','iam_files_custody','iam_files_queue'];
BEGIN
 IF jsonb_typeof(observation) IS DISTINCT FROM 'object'
 OR observation-ARRAY['version','provider','planDigest','operationId','attemptId','phase','step','completed']<>'{}'::jsonb
 OR observation->'version' IS DISTINCT FROM '2'::jsonb OR observation->>'provider' IS DISTINCT FROM 'user_azure'
 OR observation->>'phase' IS DISTINCT FROM 'observed' OR octet_length(observation::text)>32768
 OR plan->'version' IS DISTINCT FROM '2'::jsonb OR plan->>'provider' IS DISTINCT FROM 'user_azure'
 OR r->>'ownerId' IS DISTINCT FROM snapshot->>'user_id'
 OR r->>'hushhId' IS DISTINCT FROM snapshot->>'hushh_id'
 OR snapshot->>'deployment_target' IS DISTINCT FROM 'user_azure'
 OR plan->>'ownerId' IS DISTINCT FROM r->>'ownerId' OR plan->>'hushhId' IS DISTINCT FROM r->>'hushhId'
 OR plan->>'serviceUid' IS DISTINCT FROM metadata->>'serviceUid'
 OR plan->>'service' IS DISTINCT FROM snapshot->>'external_agent_id'
 OR plan->>'targetImage' IS DISTINCT FROM approval->>'targetImage'
 OR plan->>'tenantId' IS DISTINCT FROM snapshot->>'user_cloud_tenant_id'
 OR plan->>'subscriptionId' IS DISTINCT FROM snapshot->>'user_cloud_subscription_id'
 OR plan->>'resourceGroup' IS DISTINCT FROM snapshot->>'user_cloud_resource_group'
 OR plan->>'location' IS DISTINCT FROM snapshot->>'user_cloud_region'
 OR plan->>'principalId' IS DISTINCT FROM metadata->>'runtime_principal_id'
 OR plan->>'clientId' IS DISTINCT FROM metadata->>'runtime_client_id'
 OR coalesce(metadata->>'upgradeLease','')='' OR intent->>'phase' IS DISTINCT FROM 'intent'
 OR intent->>'planDigest' IS DISTINCT FROM approval->>'capabilityPlanDigest'
 OR coalesce(intent->>'planDigest','') !~ '^[a-f0-9]{64}$'
 OR intent->>'operationId' IS DISTINCT FROM approval->>'operationId'
 OR coalesce(intent->>'operationId','')=''
 OR intent->>'attemptId' IS DISTINCT FROM encode(sha256(convert_to(metadata->>'upgradeLease','UTF8')),'hex')
 OR observation-ARRAY['phase','completed'] IS DISTINCT FROM intent-ARRAY['phase','completed']
 OR jsonb_typeof(prefix) IS DISTINCT FROM 'array' OR jsonb_typeof(completed) IS DISTINCT FROM 'array'
 OR inventory->>'version' IS DISTINCT FROM 'azure.files.inventory.v1'
 OR inventory->>'ownerId' IS DISTINCT FROM plan->>'ownerId'
 OR inventory->>'hushhId' IS DISTINCT FROM plan->>'hushhId'
 OR inventory->>'serviceUid' IS DISTINCT FROM plan->>'serviceUid'
 OR inventory->>'tenantId' IS DISTINCT FROM plan->>'tenantId'
 OR inventory->>'subscriptionId' IS DISTINCT FROM plan->>'subscriptionId'
 OR inventory->>'resourceGroup' IS DISTINCT FROM plan->>'resourceGroup'
 OR inventory->>'setupNonce' IS DISTINCT FROM plan->>'setupNonce'
 OR inventory->>'planDigest' IS DISTINCT FROM approval->>'capabilityPlanDigest'
 OR jsonb_typeof(calls) IS DISTINCT FROM 'array' THEN RETURN false; END IF;
 IF jsonb_array_length(calls)<>4 OR jsonb_array_length(prefix)>=4
 OR observation->>'step' IS DISTINCT FROM steps[jsonb_array_length(prefix)+1]
 OR jsonb_array_length(completed)<>jsonb_array_length(prefix)+1
 OR completed-(jsonb_array_length(completed)-1) IS DISTINCT FROM prefix THEN RETURN false; END IF;
 group_path:='/subscriptions/'||(plan->>'subscriptionId')||'/resourceGroups/'||(plan->>'resourceGroup');
 storage_path:=plan->>'storageId'; queue_path:=storage_path||'/queueServices/default/queues/files-organization';
 role_path:=calls->1->>'path';
 IF coalesce(storage_path,'') !~ ('^'||group_path||'/providers/Microsoft.Storage/storageAccounts/[a-z0-9]{3,24}$')
 OR coalesce(role_path,'') !~ ('^'||group_path||'/providers/Microsoft.Authorization/roleDefinitions/[a-f0-9-]{36}$')
 THEN RETURN false; END IF;
 FOR i IN 0..3 LOOP
  call:=calls->i; props:=call->'body'->'properties';
  IF call->>'step' IS DISTINCT FROM steps[i+1]
   OR call-ARRAY['step','path','api','kind','body']<>'{}'::jsonb
   OR (call->'body')-'properties'<>'{}'::jsonb THEN RETURN false; END IF;
  IF i=0 THEN
   IF call->>'path' IS DISTINCT FROM queue_path OR call->>'kind' IS DISTINCT FROM 'resource'
    OR call->>'api' IS DISTINCT FROM 'storage' OR props IS DISTINCT FROM '{}'::jsonb THEN RETURN false; END IF;
  ELSIF i=1 THEN
   IF call->>'kind' IS DISTINCT FROM 'role_definition' OR call->>'api' IS DISTINCT FROM 'authorization'
    OR props-ARRAY['roleName','description','type','permissions','assignableScopes']<>'{}'::jsonb
    OR props->>'type' IS DISTINCT FROM 'CustomRole'
    OR props->'assignableScopes' IS DISTINCT FROM jsonb_build_array(group_path)
    OR props->'permissions' IS DISTINCT FROM jsonb_build_array(jsonb_build_object(
      'actions',jsonb_build_array('Microsoft.Storage/storageAccounts/read',
       'Microsoft.Storage/storageAccounts/blobServices/read','Microsoft.Storage/storageAccounts/blobServices/containers/read'),
      'notActions','[]'::jsonb)) THEN RETURN false; END IF;
  ELSE
   IF call->>'kind' IS DISTINCT FROM 'role_assignment' OR call->>'api' IS DISTINCT FROM 'authorization'
    OR coalesce(call->>'path','') !~ ('^'||CASE WHEN i=2 THEN storage_path ELSE queue_path END||'/providers/Microsoft.Authorization/roleAssignments/[a-f0-9-]{36}$')
    OR props-ARRAY['principalId','principalType','roleDefinitionId']<>'{}'::jsonb
    OR props->>'principalId' IS DISTINCT FROM plan->>'principalId'
    OR props->>'principalType' IS DISTINCT FROM 'ServicePrincipal'
    OR props->>'roleDefinitionId' IS DISTINCT FROM (CASE WHEN i=2 THEN
     '/subscriptions/'||(plan->>'subscriptionId')||'/providers/Microsoft.Authorization/roleDefinitions/'||split_part(role_path,'/roleDefinitions/',2) ELSE
     '/subscriptions/'||(plan->>'subscriptionId')||'/providers/Microsoft.Authorization/roleDefinitions/974c5e8b-45b9-4653-ba55-5f855dd0fb88' END)
   THEN RETURN false; END IF;
  END IF;
 END LOOP;
 FOR i IN 0..jsonb_array_length(completed)-1 LOOP
  result:=completed->i; call:=calls->i;
  IF result-ARRAY['step','ok','status','observation']<>'{}'::jsonb
   OR result->>'step' IS DISTINCT FROM steps[i+1]
   OR jsonb_typeof(result->'ok') IS DISTINCT FROM 'boolean'
   OR jsonb_typeof(result->'status') IS DISTINCT FROM 'number'
   OR coalesce(result->>'status','') !~ '^[0-9]{1,3}$' OR (result->>'status')::int>599 THEN RETURN false; END IF;
  IF result->'ok'='true'::jsonb THEN
   IF result->>'status' NOT IN ('200','201')
    OR result->'observation' IS DISTINCT FROM jsonb_build_object('id',call->>'path','kind',call->>'kind','properties',call->'body'->'properties')
   THEN RETURN false; END IF;
  ELSIF result ? 'observation' OR i<>jsonb_array_length(completed)-1 THEN RETURN false; END IF;
 END LOOP;
 RETURN true;
END $function$
$object$;
 ELSIF encode(sha256(convert_to(actual,'UTF8')),'hex') NOT IN ('596d74733da907a6bad0cd8a8fba419b5621483a1ce3f2ed541dae290f51671a') THEN
  RAISE EXCEPTION 'Unqualified schema drift: valid_erasure_azure_files_upgrade_observation';
 END IF;
END
$object_guard$;

REVOKE ALL ON FUNCTION public."valid_erasure_azure_files_upgrade_observation"(jsonb, jsonb) FROM PUBLIC;

DO $pod_414$
BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN GRANT EXECUTE ON FUNCTION public."valid_erasure_azure_files_upgrade_observation"(jsonb, jsonb) TO service_role; END IF;
END
$pod_414$;

DO $object_guard$
DECLARE actual text;
BEGIN
 SELECT definition INTO actual FROM (SELECT pg_get_functiondef(p.oid) definition FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='valid_erasure_bootstrap_append' AND pg_get_function_identity_arguments(p.oid)='old_r jsonb, new_r jsonb') observed;
 IF actual IS NULL THEN
  EXECUTE $object$CREATE OR REPLACE FUNCTION public.valid_erasure_bootstrap_append(old_r jsonb, new_r jsonb)
 RETURNS boolean
 LANGUAGE plpgsql
 IMMUTABLE
 SET search_path TO 'public'
AS $function$
DECLARE before_groups jsonb:=coalesce(old_r->'bootstrapGrantErasure','{}'::jsonb); after_groups jsonb:=new_r->'bootstrapGrantErasure';
 item record; stage record; original jsonb; wanted jsonb; captured_grant jsonb; changed integer:=0; additions integer; expected_status text;
BEGIN
 IF old_r-'bootstrapGrantErasure' IS DISTINCT FROM new_r-'bootstrapGrantErasure'
 OR jsonb_typeof(old_r->'bootstrapGrantRelease') IS DISTINCT FROM 'object'
 OR jsonb_typeof(after_groups) IS DISTINCT FROM 'object'
 OR NOT after_groups ?& ARRAY(SELECT jsonb_object_keys(before_groups)) THEN RETURN false; END IF;
 FOR item IN SELECT * FROM jsonb_each(after_groups) LOOP
  original:=coalesce(before_groups->item.key,'{}'::jsonb);
  IF original=item.value THEN CONTINUE; END IF;
  changed:=changed+1; additions:=0; captured_grant:=old_r->'bootstrapGrantRelease'->'groups'->item.key;
  IF captured_grant IS NULL OR jsonb_typeof(item.value) IS DISTINCT FROM 'object' OR original ? 'deletion'
   OR item.value - ARRAY['admission','acknowledgement','deletion']<>'{}'::jsonb
   OR NOT item.value ?& ARRAY(SELECT jsonb_object_keys(original)) OR NOT item.value ? 'admission' THEN RETURN false; END IF;
  FOR stage IN SELECT * FROM jsonb_each(item.value) LOOP
   IF original ? stage.key THEN IF original->stage.key IS DISTINCT FROM stage.value THEN RETURN false; END IF; CONTINUE; END IF;
   additions:=additions+1;
   expected_status:=CASE stage.key WHEN 'admission' THEN 'admitted' WHEN 'acknowledgement' THEN 'acknowledged' WHEN 'deletion' THEN 'observed_absent' END;
   wanted:=jsonb_build_object('ownerId',old_r->>'ownerId','attemptId',old_r->>'attemptId',
    'bootstrapIdentity',captured_grant->'bootstrapIdentity','bindingObservation',captured_grant->'bindingObservation','status',expected_status);
   IF stage.value IS DISTINCT FROM wanted OR (stage.key<>'admission' AND NOT original ? 'admission') THEN RETURN false; END IF;
  END LOOP;
  IF additions<>1 THEN RETURN false; END IF;
  -- The active recovery grant is admitted only after every other captured captured_grant is absent.
  IF item.key=old_r->'bootstrapGrantRelease'->>'recoveryGrantKey' AND NOT original ? 'admission' AND EXISTS (
   SELECT 1 FROM jsonb_object_keys(old_r->'bootstrapGrantRelease'->'groups') k
   WHERE k<>item.key AND before_groups->k->'deletion'->>'status' IS DISTINCT FROM 'observed_absent') THEN RETURN false; END IF;
 END LOOP;
 RETURN changed=1;
END;
$function$
$object$;
 ELSIF encode(sha256(convert_to(actual,'UTF8')),'hex') NOT IN ('a3369c65cdebd766aabdad9d28c5721ae9b343fd0cd69b56208cbc55ca9b545d') THEN
  RAISE EXCEPTION 'Unqualified schema drift: valid_erasure_bootstrap_append';
 END IF;
END
$object_guard$;

REVOKE ALL ON FUNCTION public."valid_erasure_bootstrap_append"(jsonb, jsonb) FROM PUBLIC;

DO $pod_414$
BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN GRANT EXECUTE ON FUNCTION public."valid_erasure_bootstrap_append"(jsonb, jsonb) TO service_role; END IF;
END
$pod_414$;

DO $object_guard$
DECLARE actual text;
BEGIN
 SELECT definition INTO actual FROM (SELECT pg_get_functiondef(p.oid) definition FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='valid_erasure_bucket_append' AND pg_get_function_identity_arguments(p.oid)='before_record jsonb, after_record jsonb') observed;
 IF actual IS NULL THEN
  EXECUTE $object$CREATE OR REPLACE FUNCTION public.valid_erasure_bucket_append(before_record jsonb, after_record jsonb)
 RETURNS boolean
 LANGUAGE plpgsql
 IMMUTABLE
 SET search_path TO 'public'
AS $function$
DECLARE stage text;
BEGIN
 FOREACH stage IN ARRAY ARRAY['bucketAdmission','bucketAcknowledgement','bucketDeletion'] LOOP
  IF NOT (before_record ? stage) AND after_record ? stage
     AND after_record-stage=before_record
     AND public.valid_erasure_bucket_receipt(before_record,stage,after_record->stage) IS TRUE THEN RETURN true; END IF;
 END LOOP;
 RETURN false;
END;
$function$
$object$;
 ELSIF encode(sha256(convert_to(actual,'UTF8')),'hex') NOT IN ('7d9d2197d7916993d3ca7914ef41cfc54881a736f1b7ed9029d5d4c1472b4ed8') THEN
  RAISE EXCEPTION 'Unqualified schema drift: valid_erasure_bucket_append';
 END IF;
END
$object_guard$;

REVOKE ALL ON FUNCTION public."valid_erasure_bucket_append"(jsonb, jsonb) FROM PUBLIC;

DO $pod_414$
BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN GRANT EXECUTE ON FUNCTION public."valid_erasure_bucket_append"(jsonb, jsonb) TO service_role; END IF;
END
$pod_414$;

DO $object_guard$
DECLARE actual text;
BEGIN
 SELECT definition INTO actual FROM (SELECT pg_get_functiondef(p.oid) definition FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='valid_erasure_bucket_receipt' AND pg_get_function_identity_arguments(p.oid)='reservation jsonb, stage text, receipt jsonb') observed;
 IF actual IS NULL THEN
  EXECUTE $object$CREATE OR REPLACE FUNCTION public.valid_erasure_bucket_receipt(reservation jsonb, stage text, receipt jsonb)
 RETURNS boolean
 LANGUAGE plpgsql
 IMMUTABLE
 SET search_path TO 'public'
AS $function$
DECLARE inventory jsonb; identity jsonb; admission jsonb;
BEGIN
 IF public.valid_erasure_writer_receipt(reservation,'writerDisabled',reservation->'writerDisabled') IS DISTINCT FROM true
    OR stage IS NULL OR stage NOT IN ('bucketAdmission','bucketAcknowledgement','bucketDeletion')
    OR jsonb_typeof(receipt) IS DISTINCT FROM 'object' THEN RETURN false; END IF;
 inventory := reservation->'substrateInventory'; identity := receipt->'bucketIdentity';
 IF receipt->>'ownerId' IS DISTINCT FROM reservation->>'ownerId'
    OR receipt->>'attemptId' IS DISTINCT FROM reservation->>'attemptId'
    OR receipt - ARRAY['ownerId','attemptId','bucketIdentity','metageneration','status'] <> '{}'::jsonb
    OR jsonb_typeof(identity) IS DISTINCT FROM 'object'
    OR jsonb_typeof(receipt->'metageneration') IS DISTINCT FROM 'string'
    OR receipt->>'metageneration' !~ '^[1-9][0-9]{0,19}$'
    OR identity - ARRAY['name','generation','projectNumber','timeCreated'] <> '{}'::jsonb
    OR identity->>'name' IS NULL OR identity->>'name' = ''
    OR identity->>'generation' IS NULL OR identity->>'generation' !~ '^[1-9][0-9]{0,19}$'
    OR identity->>'projectNumber' IS NULL OR identity->>'projectNumber' !~ '^[1-9][0-9]{0,19}$'
    OR identity->>'timeCreated' IS NULL OR identity->>'timeCreated' = '' THEN RETURN false; END IF;
 IF (SELECT count(*) FROM jsonb_array_elements(inventory->'resourceObservations') AS r
     WHERE r->>'type'='gcs_bucket' AND r->>'disposition'='created'
       AND r->>'id'=identity->>'name' AND r->'identity'=identity) <> 1
    OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(inventory->'plannedResources') AS r
                   WHERE r->>'type'='gcs_bucket' AND r->>'id'=identity->>'name') THEN RETURN false; END IF;
 IF stage='bucketAdmission' THEN RETURN receipt->>'status'='admitted'; END IF;
 admission := reservation->'bucketAdmission';
 IF public.valid_erasure_bucket_receipt(reservation,'bucketAdmission',admission) IS DISTINCT FROM true
    OR receipt - 'status' IS DISTINCT FROM admission - 'status' THEN RETURN false; END IF;
 IF stage='bucketAcknowledgement' THEN RETURN receipt->>'status'='acknowledged'; END IF;
 RETURN receipt->>'status'='deleted'
    AND public.valid_erasure_bucket_receipt(reservation,'bucketAcknowledgement',reservation->'bucketAcknowledgement');
END;
$function$
$object$;
 ELSIF encode(sha256(convert_to(actual,'UTF8')),'hex') NOT IN ('d59e2a33623d7eb3605e3ffcfb2fe860ecf70ce3a4b7172046e2d3c4e5cddea9') THEN
  RAISE EXCEPTION 'Unqualified schema drift: valid_erasure_bucket_receipt';
 END IF;
END
$object_guard$;

REVOKE ALL ON FUNCTION public."valid_erasure_bucket_receipt"(jsonb, text, jsonb) FROM PUBLIC;

DO $pod_414$
BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN GRANT EXECUTE ON FUNCTION public."valid_erasure_bucket_receipt"(jsonb, text, jsonb) TO service_role; END IF;
END
$pod_414$;

DO $object_guard$
DECLARE actual text;
BEGIN
 SELECT definition INTO actual FROM (SELECT pg_get_functiondef(p.oid) definition FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='valid_erasure_compute_append' AND pg_get_function_identity_arguments(p.oid)='previous jsonb, candidate jsonb') observed;
 IF actual IS NULL THEN
  EXECUTE $object$CREATE OR REPLACE FUNCTION public.valid_erasure_compute_append(previous jsonb, candidate jsonb)
 RETURNS boolean
 LANGUAGE plpgsql
 IMMUTABLE
 SET search_path TO 'public'
AS $function$
DECLARE stage text;
BEGIN
 FOREACH stage IN ARRAY ARRAY['computeAdmission','computeAcknowledgement','computeDeletion'] LOOP
   IF NOT (previous ? stage) AND candidate ? stage
      AND candidate - stage = previous
      AND public.valid_erasure_compute_receipt(previous,stage,candidate->stage) THEN RETURN true; END IF;
 END LOOP;
 RETURN false;
END;
$function$
$object$;
 ELSIF encode(sha256(convert_to(actual,'UTF8')),'hex') NOT IN ('1533d50dfd251af2fdc79eb85bb8e058e1c3a47adf0080804d6bcc991feea86f') THEN
  RAISE EXCEPTION 'Unqualified schema drift: valid_erasure_compute_append';
 END IF;
END
$object_guard$;

REVOKE ALL ON FUNCTION public."valid_erasure_compute_append"(jsonb, jsonb) FROM PUBLIC;

DO $pod_414$
BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN GRANT EXECUTE ON FUNCTION public."valid_erasure_compute_append"(jsonb, jsonb) TO service_role; END IF;
END
$pod_414$;

DO $object_guard$
DECLARE actual text;
BEGIN
 SELECT definition INTO actual FROM (SELECT pg_get_functiondef(p.oid) definition FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='valid_erasure_compute_receipt' AND pg_get_function_identity_arguments(p.oid)='reservation jsonb, stage text, receipt jsonb') observed;
 IF actual IS NULL THEN
  EXECUTE $object$CREATE OR REPLACE FUNCTION public.valid_erasure_compute_receipt(reservation jsonb, stage text, receipt jsonb)
 RETURNS boolean
 LANGUAGE plpgsql
 IMMUTABLE
 SET search_path TO 'public'
AS $function$
DECLARE
 snapshot jsonb := reservation->'registrySnapshot';
 attempt jsonb := snapshot->'backend_metadata'->'provisionAttempt';
 creation jsonb := attempt->'evidence'->'host_requested'->'creationAcknowledgement';
 admission jsonb := reservation->'computeAdmission';
 acknowledgement jsonb := reservation->'computeAcknowledgement';
 key text;
BEGIN
 IF jsonb_typeof(receipt) IS DISTINCT FROM 'object'
    OR NOT public.valid_erasure_memory_deletion(reservation,reservation->'memoryDeletion')
    OR attempt->'version' IS DISTINCT FROM '1'::jsonb
    OR attempt->>'ownerId' IS DISTINCT FROM reservation->>'ownerId'
    OR attempt->>'phase' IS DISTINCT FROM 'provisioned'
    OR creation->'initialGeneration' IS DISTINCT FROM '1'::jsonb
    OR creation->>'serviceUid' IS DISTINCT FROM snapshot->'backend_metadata'->>'serviceUid'
    OR creation->>'service' IS DISTINCT FROM reservation->'memoryBinding'->>'service'
    OR creation->>'backend' IS DISTINCT FROM snapshot->>'backend' THEN RETURN false; END IF;
 IF stage='computeAdmission' THEN
   IF receipt - ARRAY['serviceName','serviceUid','etag','generation','image'] <> '{}'::jsonb
      OR receipt->>'serviceName' IS DISTINCT FROM 'projects/' || (creation->>'project') || '/locations/' || (creation->>'region') || '/services/' || (creation->>'service')
      OR receipt->>'serviceUid' IS DISTINCT FROM creation->>'serviceUid'
      OR receipt->'generation' IS DISTINCT FROM '1'::jsonb
      OR receipt->>'image' IS DISTINCT FROM creation->>'initialImage'
      OR coalesce(receipt->>'image','') !~ '^.+@sha256:[a-f0-9]{64}$'
      OR coalesce(receipt->>'serviceName','') !~ '^projects/[A-Za-z0-9_-]+/locations/[A-Za-z0-9_-]+/services/[a-z0-9-]+$' THEN RETURN false; END IF;
   FOREACH key IN ARRAY ARRAY['serviceName','serviceUid','etag','image'] LOOP
     IF jsonb_typeof(receipt->key) IS DISTINCT FROM 'string'
        OR length(receipt->>key) NOT BETWEEN 1 AND 1024
        OR receipt->>key <> btrim(receipt->>key)
        OR receipt->>key ~ '[[:cntrl:]]' THEN RETURN false; END IF;
   END LOOP;
   RETURN true;
 ELSIF stage='computeAcknowledgement' THEN
   RETURN coalesce(public.valid_erasure_compute_receipt(reservation,'computeAdmission',admission)
      AND receipt - 'operationName' = admission
      AND jsonb_typeof(receipt->'operationName')='string'
      AND length(receipt->>'operationName') BETWEEN 1 AND 1024
      AND receipt->>'operationName' ~ '^projects/[A-Za-z0-9_-]+/locations/[A-Za-z0-9_-]+/operations/[A-Za-z0-9_-]+$'
      AND split_part(receipt->>'operationName','/',2)=creation->>'project'
      AND split_part(receipt->>'operationName','/',4)=creation->>'region',false);
 ELSIF stage='computeDeletion' THEN
   RETURN coalesce(public.valid_erasure_compute_receipt(reservation,'computeAcknowledgement',acknowledgement)
      AND receipt - 'status' = acknowledgement AND receipt->>'status'='compute_deleted',false);
 END IF;
 RETURN false;
END;
$function$
$object$;
 ELSIF encode(sha256(convert_to(actual,'UTF8')),'hex') NOT IN ('5d7e160a43b00acae4cc40157ba3374600a6bcc7f42eb6ae4b63686f19bb5f02') THEN
  RAISE EXCEPTION 'Unqualified schema drift: valid_erasure_compute_receipt';
 END IF;
END
$object_guard$;

REVOKE ALL ON FUNCTION public."valid_erasure_compute_receipt"(jsonb, text, jsonb) FROM PUBLIC;

DO $pod_414$
BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN GRANT EXECUTE ON FUNCTION public."valid_erasure_compute_receipt"(jsonb, text, jsonb) TO service_role; END IF;
END
$pod_414$;

DO $object_guard$
DECLARE actual text;
BEGIN
 SELECT definition INTO actual FROM (SELECT pg_get_functiondef(p.oid) definition FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='valid_erasure_files_append' AND pg_get_function_identity_arguments(p.oid)='before_record jsonb, after_record jsonb') observed;
 IF actual IS NULL THEN
  EXECUTE $object$CREATE OR REPLACE FUNCTION public.valid_erasure_files_append(before_record jsonb, after_record jsonb)
 RETURNS boolean
 LANGUAGE plpgsql
 IMMUTABLE
 SET search_path TO 'public'
AS $function$
DECLARE kind text; stage text; old_mail jsonb; new_mail jsonb; old_kind jsonb; new_kind jsonb;
BEGIN
 old_mail:=coalesce(before_record->'filesErasure','{}'::jsonb); new_mail:=after_record->'filesErasure';
 IF jsonb_typeof(new_mail) IS DISTINCT FROM 'object' OR after_record-'filesErasure' IS DISTINCT FROM before_record-'filesErasure' THEN RETURN false; END IF;
 FOREACH kind IN ARRAY ARRAY['queue','worker'] LOOP
  old_kind:=coalesce(old_mail->kind,'{}'::jsonb); new_kind:=new_mail->kind;
  FOREACH stage IN ARRAY ARRAY['admission','quiescence','acknowledgement','deletion'] LOOP
   IF NOT (old_kind ? stage) AND new_kind ? stage AND new_mail-kind=old_mail-kind
      AND new_kind-stage=old_kind AND public.valid_erasure_files_receipt(before_record,kind,stage,new_kind->stage) IS TRUE THEN RETURN true; END IF;
  END LOOP;
 END LOOP;
 RETURN false;
END;
$function$
$object$;
 ELSIF encode(sha256(convert_to(actual,'UTF8')),'hex') NOT IN ('806a30747c7e70cea8a76c029cd4c0c236bc3884b965f8d6e532b47ee000fbec') THEN
  RAISE EXCEPTION 'Unqualified schema drift: valid_erasure_files_append';
 END IF;
END
$object_guard$;

REVOKE ALL ON FUNCTION public."valid_erasure_files_append"(jsonb, jsonb) FROM PUBLIC;

DO $pod_414$
BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN GRANT EXECUTE ON FUNCTION public."valid_erasure_files_append"(jsonb, jsonb) TO service_role; END IF;
END
$pod_414$;

DO $object_guard$
DECLARE actual text;
BEGIN
 SELECT definition INTO actual FROM (SELECT pg_get_functiondef(p.oid) definition FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='valid_erasure_files_receipt' AND pg_get_function_identity_arguments(p.oid)='r jsonb, kind text, stage text, receipt jsonb') observed;
 IF actual IS NULL THEN
  EXECUTE $object$CREATE OR REPLACE FUNCTION public.valid_erasure_files_receipt(r jsonb, kind text, stage text, receipt jsonb)
 RETURNS boolean
 LANGUAGE plpgsql
 IMMUTABLE
 SET search_path TO 'public'
AS $function$
DECLARE inv jsonb:=r->'substrateInventory'; obs jsonb:=receipt->'resourceObservation'; identity jsonb:=obs->'identity';
 project text:=r->'registrySnapshot'->>'user_cloud_project'; region text:=r->'registrySnapshot'->>'user_cloud_region';
 slug text:='one-files-'||left(encode(sha256(convert_to(r->>'hushhId','UTF8')),'hex'),20);
 rid text; rtype text; admitted jsonb;
BEGIN
 IF kind IS NULL OR kind NOT IN ('queue','worker') OR stage IS NULL OR stage NOT IN ('admission','quiescence','acknowledgement','deletion')
 OR public.valid_erasure_writer_receipt(r,'writerDisabled',r->'writerDisabled') IS DISTINCT FROM true
 OR public.valid_erasure_compute_receipt(r,'computeDeletion',r->'computeDeletion') IS DISTINCT FROM true
 OR jsonb_typeof(receipt) IS DISTINCT FROM 'object'
 OR receipt-ARRAY['ownerId','attemptId','resourceObservation','status']<>'{}'::jsonb
 OR receipt->>'ownerId' IS DISTINCT FROM r->>'ownerId' OR receipt->>'attemptId' IS DISTINCT FROM r->>'attemptId'
 OR r->'registrySnapshot'->>'deployment_target' IS DISTINCT FROM 'user_gcp'
 OR project IS NULL OR region IS NULL OR slug IS NULL
 OR jsonb_typeof(obs) IS DISTINCT FROM 'object' OR obs-ARRAY['type','id','disposition','identity']<>'{}'::jsonb
 OR obs->>'disposition' IS DISTINCT FROM 'created' THEN RETURN false; END IF;
 rtype:=CASE kind WHEN 'queue' THEN 'cloud_tasks_queue' ELSE 'service_account' END;
 rid:=CASE kind WHEN 'queue' THEN slug ELSE slug||'@'||project||'.iam.gserviceaccount.com' END;
 IF obs->>'type' IS DISTINCT FROM rtype OR obs->>'id' IS DISTINCT FROM rid
 OR (SELECT count(*) FROM jsonb_array_elements(inv->'plannedResources') x WHERE x->>'type'=rtype AND x->>'id'=rid)<>1
 OR (SELECT count(*) FROM jsonb_array_elements(inv->'resourceObservations') x WHERE x=obs)<>1 THEN RETURN false; END IF;
 IF kind='queue' THEN
   IF identity IS DISTINCT FROM jsonb_build_object('name','projects/'||project||'/locations/'||region||'/queues/'||rid,
     'rateLimits',jsonb_build_object('maxDispatchesPerSecond',1,'maxConcurrentDispatches',1),
     'retryConfig',jsonb_build_object('maxAttempts',3,'maxRetryDuration','0s','minBackoff','10s','maxBackoff','60s','maxDoublings',2)) THEN RETURN false; END IF;
 ELSE
   IF jsonb_typeof(identity) IS DISTINCT FROM 'object' OR identity-ARRAY['name','email','projectId','uniqueId']<>'{}'::jsonb
    OR (identity->>'name' IS DISTINCT FROM 'projects/'||project||'/serviceAccounts/'||rid AND identity->>'name' IS DISTINCT FROM 'projects/'||project||'/serviceAccounts/'||(identity->>'uniqueId'))
    OR identity->>'email' IS DISTINCT FROM rid OR identity->>'projectId' IS DISTINCT FROM project
    OR (coalesce(identity->>'uniqueId','') !~ '^[0-9]{1,32}$' OR identity->>'uniqueId' !~ '[1-9]')
    OR identity->>'email'=r->'writerDisabled'->'runtimeIdentity'->>'email'
    OR public.valid_erasure_files_receipt(r,'queue','deletion',r->'filesErasure'->'queue'->'deletion') IS DISTINCT FROM true THEN RETURN false; END IF;
 END IF;
 IF stage='admission' THEN RETURN receipt->>'status'='admitted'; END IF;
 admitted:=r->'filesErasure'->kind->'admission';
 IF public.valid_erasure_files_receipt(r,kind,'admission',admitted) IS DISTINCT FROM true OR receipt-'status' IS DISTINCT FROM admitted-'status' THEN RETURN false; END IF;
 IF stage='quiescence' THEN RETURN receipt->>'status'='quiesced'; END IF;
 IF public.valid_erasure_files_receipt(r,kind,'quiescence',r->'filesErasure'->kind->'quiescence') IS DISTINCT FROM true THEN RETURN false; END IF;
 IF stage='acknowledgement' THEN RETURN receipt->>'status'='acknowledged'; END IF;
 RETURN receipt->>'status'='absent' AND public.valid_erasure_files_receipt(r,kind,'acknowledgement',r->'filesErasure'->kind->'acknowledgement') IS TRUE;
END;
$function$
$object$;
 ELSIF encode(sha256(convert_to(actual,'UTF8')),'hex') NOT IN ('dc0122b80000b4c4698f132b11377676b6cb18a31efd5c7e49fd8137428f9ab5') THEN
  RAISE EXCEPTION 'Unqualified schema drift: valid_erasure_files_receipt';
 END IF;
END
$object_guard$;

REVOKE ALL ON FUNCTION public."valid_erasure_files_receipt"(jsonb, text, text, jsonb) FROM PUBLIC;

DO $pod_414$
BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN GRANT EXECUTE ON FUNCTION public."valid_erasure_files_receipt"(jsonb, text, text, jsonb) TO service_role; END IF;
END
$pod_414$;

DO $object_guard$
DECLARE actual text;
BEGIN
 SELECT definition INTO actual FROM (SELECT pg_get_functiondef(p.oid) definition FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='valid_erasure_files_upgrade_observation' AND pg_get_function_identity_arguments(p.oid)='r jsonb, observation jsonb') observed;
 IF actual IS NULL THEN
  EXECUTE $object$CREATE OR REPLACE FUNCTION public.valid_erasure_files_upgrade_observation(r jsonb, observation jsonb)
 RETURNS boolean
 LANGUAGE plpgsql
 IMMUTABLE
 SET search_path TO 'public'
AS $function$
BEGIN
 IF observation->'version'='2'::jsonb THEN
  RETURN public.valid_erasure_azure_files_upgrade_observation(r,observation);
 END IF;
 RETURN public.valid_erasure_gcp_files_upgrade_observation(r,observation);
END $function$
$object$;
 ELSIF encode(sha256(convert_to(actual,'UTF8')),'hex') NOT IN ('8bcc56df14671086c05be8f595724803f3d60d2c8bbf26c18506200777abbf43') THEN
  RAISE EXCEPTION 'Unqualified schema drift: valid_erasure_files_upgrade_observation';
 END IF;
END
$object_guard$;

REVOKE ALL ON FUNCTION public."valid_erasure_files_upgrade_observation"(jsonb, jsonb) FROM PUBLIC;

DO $pod_414$
BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN GRANT EXECUTE ON FUNCTION public."valid_erasure_files_upgrade_observation"(jsonb, jsonb) TO service_role; END IF;
END
$pod_414$;

DO $object_guard$
DECLARE actual text;
BEGIN
 SELECT definition INTO actual FROM (SELECT pg_get_functiondef(p.oid) definition FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='valid_erasure_gcp_files_upgrade_observation' AND pg_get_function_identity_arguments(p.oid)='r jsonb, observation jsonb') observed;
 IF actual IS NULL THEN
  EXECUTE $object$CREATE OR REPLACE FUNCTION public.valid_erasure_gcp_files_upgrade_observation(r jsonb, observation jsonb)
 RETURNS boolean
 LANGUAGE plpgsql
 IMMUTABLE
 SET search_path TO 'public'
AS $function$
DECLARE snapshot jsonb:=r->'registrySnapshot'; metadata jsonb:=snapshot->'backend_metadata';
 approval jsonb:=metadata->'upgradeApproval'; plan jsonb:=approval->'capabilityPlan';
 intent jsonb:=metadata->'filesUpgradeCheckpoint'; prefix jsonb:=intent->'completed';
 completed jsonb:=observation->'completed'; result jsonb; resource jsonb; ident jsonb; binding jsonb;
 project text:=plan->>'project'; region text:=plan->>'region'; step text:=intent->>'step';
 slug text:='one-files-'||left(encode(sha256(convert_to(r->>'hushhId','UTF8')),'hex'),20);
 worker text; queue text; expected_role text; expected_url text; expected_member text; project_number text;
 steps text[]:=ARRAY['enable_services','generate_files_task_identity','iam_files_task_identity',
  'iam_files_queue_admin','files_worker_account','files_queue','iam_files_enqueuer','iam_files_worker_actas',
  'iam_files_bucket_metadata','iam_files_invoker'];
BEGIN
 IF jsonb_typeof(observation) IS DISTINCT FROM 'object'
 OR observation-ARRAY['version','planDigest','operationId','attemptId','phase','step','completed']<>'{}'::jsonb
 OR observation->'version' IS DISTINCT FROM '1'::jsonb OR observation->>'phase' IS DISTINCT FROM 'observed'
 OR octet_length(observation::text)>65536
 OR r->>'ownerId' IS DISTINCT FROM snapshot->>'user_id'
 OR snapshot->>'deployment_target' IS DISTINCT FROM 'user_gcp'
 OR plan->>'ownerId' IS DISTINCT FROM r->>'ownerId' OR plan->>'hushhId' IS DISTINCT FROM r->>'hushhId'
 OR plan->>'serviceUid' IS DISTINCT FROM metadata->>'serviceUid'
 OR plan->>'targetImage' IS DISTINCT FROM approval->>'targetImage'
 OR plan->>'project' IS DISTINCT FROM snapshot->>'user_cloud_project'
 OR plan->>'region' IS DISTINCT FROM snapshot->>'user_cloud_region'
 OR plan->>'service' IS DISTINCT FROM snapshot->>'external_agent_id'
 OR plan->>'runtimeAccount' IS DISTINCT FROM metadata->>'runtime_service_account'
 OR plan->>'bootstrapAccount' IS DISTINCT FROM snapshot->>'user_cloud_bootstrap_sa'
 OR coalesce(metadata->>'upgradeLease','')='' OR intent->>'phase' IS DISTINCT FROM 'intent'
 OR intent->>'planDigest' IS DISTINCT FROM approval->>'capabilityPlanDigest'
 OR coalesce(intent->>'planDigest','') !~ '^[a-f0-9]{64}$'
 OR intent->>'operationId' IS DISTINCT FROM approval->>'operationId'
 OR coalesce(intent->>'operationId','')=''
 OR intent->>'attemptId' IS DISTINCT FROM encode(sha256(convert_to(metadata->>'upgradeLease','UTF8')),'hex')
 OR observation-ARRAY['phase','completed'] IS DISTINCT FROM intent-ARRAY['phase','completed']
 OR jsonb_typeof(prefix) IS DISTINCT FROM 'array' OR jsonb_typeof(completed) IS DISTINCT FROM 'array'
 THEN RETURN false; END IF;
 IF jsonb_array_length(prefix)>=cardinality(steps)
 OR step IS DISTINCT FROM steps[jsonb_array_length(prefix)+1]
 OR jsonb_array_length(completed)<>jsonb_array_length(prefix)+1
 OR completed-(jsonb_array_length(completed)-1) IS DISTINCT FROM prefix THEN RETURN false; END IF;
 result:=completed->-1;
 IF jsonb_typeof(result) IS DISTINCT FROM 'object'
 OR result-ARRAY['step','status','ok','skipped','resourceObservation','bindingObservations']<>'{}'::jsonb
 OR result->>'step' IS DISTINCT FROM step OR jsonb_typeof(result->'ok') IS DISTINCT FROM 'boolean'
 OR jsonb_typeof(result->'status') IS DISTINCT FROM 'number'
 OR coalesce(result->>'status','') !~ '^[0-9]{1,3}$'
 OR (result ? 'skipped' AND result->'skipped' IS DISTINCT FROM 'false'::jsonb)
 THEN RETURN false; END IF;
 SELECT x->'identity'->>'projectNumber' INTO project_number
 FROM jsonb_array_elements(metadata->'substrateReceipt'->'resourceObservations') x
 WHERE x->>'type'='gcs_bucket' AND x->>'id'=plan->>'bucket'
 AND x->'identity'->>'name'=plan->>'bucket';
 IF coalesce(project_number,'') !~ '^[1-9][0-9]{0,19}$' THEN RETURN false; END IF;
 worker:=slug||'@'||project||'.iam.gserviceaccount.com';
 queue:='projects/'||project||'/locations/'||region||'/queues/'||slug;
 resource:=result->'resourceObservation';
 IF resource IS NOT NULL THEN
  IF result->'ok' IS DISTINCT FROM 'true'::jsonb OR result->>'status' NOT IN ('200','201')
  OR jsonb_typeof(resource) IS DISTINCT FROM 'object'
  OR resource-ARRAY['type','id','disposition','identity']<>'{}'::jsonb
  OR resource->>'disposition' IS DISTINCT FROM 'created'
  OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(metadata->'substrateReceipt'->'plannedResources') x
     WHERE x=jsonb_build_object('type',resource->>'type','id',resource->>'id')) THEN RETURN false; END IF;
  ident:=resource->'identity';
  IF step='files_queue' THEN
   IF resource->>'type' IS DISTINCT FROM 'cloud_tasks_queue' OR resource->>'id' IS DISTINCT FROM slug
   OR ident IS DISTINCT FROM jsonb_build_object('name',queue,
    'rateLimits',jsonb_build_object('maxDispatchesPerSecond',1,'maxConcurrentDispatches',1),
    'retryConfig',jsonb_build_object('maxAttempts',3,'maxRetryDuration','0s','minBackoff','10s','maxBackoff','60s','maxDoublings',2))
   THEN RETURN false; END IF;
  ELSIF step='files_worker_account' THEN
   IF resource->>'type' IS DISTINCT FROM 'service_account' OR resource->>'id' IS DISTINCT FROM worker
   OR jsonb_typeof(ident) IS DISTINCT FROM 'object' OR ident-ARRAY['name','email','projectId','uniqueId']<>'{}'::jsonb
   OR ident->>'email' IS DISTINCT FROM worker OR ident->>'projectId' IS DISTINCT FROM project
   OR (coalesce(ident->>'uniqueId','') !~ '^[0-9]{1,32}$' OR ident->>'uniqueId' !~ '[1-9]')
   OR (ident->>'name' IS DISTINCT FROM 'projects/'||project||'/serviceAccounts/'||worker
       AND ident->>'name' IS DISTINCT FROM 'projects/'||project||'/serviceAccounts/'||(ident->>'uniqueId'))
   THEN RETURN false; END IF;
  ELSE RETURN false; END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(coalesce(metadata->'substrateReceipt'->'resourceObservations','[]'::jsonb)) x
    WHERE x->>'type'=resource->>'type' AND x->>'id'=resource->>'id' AND x<>resource) THEN RETURN false; END IF;
 END IF;
 IF result ? 'bindingObservations' THEN
  IF jsonb_typeof(result->'bindingObservations') IS DISTINCT FROM 'array'
  OR jsonb_array_length(result->'bindingObservations')>1 THEN RETURN false; END IF;
  IF jsonb_array_length(result->'bindingObservations')>0 AND
    (result->'ok' IS DISTINCT FROM 'true'::jsonb OR result->>'status' NOT IN ('200','201')) THEN RETURN false; END IF;
  CASE step
   WHEN 'iam_files_queue_admin' THEN
    expected_role:='roles/cloudtasks.queueAdmin'; expected_member:='serviceAccount:'||(plan->>'bootstrapAccount');
    expected_url:='https://cloudresourcemanager.googleapis.com/v1/projects/'||project||':getIamPolicy';
   WHEN 'iam_files_task_identity' THEN
    expected_role:='roles/cloudtasks.serviceAgent'; expected_member:='serviceAccount:service-'||project_number||'@gcp-sa-cloudtasks.iam.gserviceaccount.com';
    expected_url:='https://cloudresourcemanager.googleapis.com/v1/projects/'||project||':getIamPolicy';
   WHEN 'iam_files_enqueuer' THEN
    expected_role:='roles/cloudtasks.enqueuer'; expected_member:='serviceAccount:'||(plan->>'runtimeAccount');
    expected_url:='https://cloudtasks.googleapis.com/v2/'||queue||':getIamPolicy';
   WHEN 'iam_files_worker_actas' THEN
    expected_role:='roles/iam.serviceAccountUser'; expected_member:='serviceAccount:'||(plan->>'runtimeAccount');
    expected_url:='https://iam.googleapis.com/v1/projects/'||project||'/serviceAccounts/'||worker||':getIamPolicy';
   WHEN 'iam_files_bucket_metadata' THEN
    expected_role:='roles/storage.legacyBucketReader'; expected_member:='serviceAccount:'||(plan->>'runtimeAccount');
    expected_url:='https://storage.googleapis.com/storage/v1/b/'||(plan->>'bucket')||'/iam';
   WHEN 'iam_files_invoker' THEN
    expected_role:='roles/run.invoker'; expected_member:='serviceAccount:'||worker;
    expected_url:='https://'||region||'-run.googleapis.com/v1/projects/'||project||'/locations/'||region||'/services/'||(plan->>'service')||':getIamPolicy';
   ELSE RETURN false;
  END CASE;
  FOR binding IN SELECT value FROM jsonb_array_elements(result->'bindingObservations') LOOP
   IF jsonb_typeof(binding) IS DISTINCT FROM 'object'
   OR binding-ARRAY['step','policyResource','role','member','disposition','beforeEtag','afterEtag']<>'{}'::jsonb
   OR binding->>'step' IS DISTINCT FROM step OR binding->>'policyResource' IS DISTINCT FROM expected_url
   OR binding->>'role' IS DISTINCT FROM expected_role
   OR coalesce(binding->>'disposition','') NOT IN ('added','already_present')
   OR jsonb_typeof(binding->'beforeEtag') IS DISTINCT FROM 'string' OR length(binding->>'beforeEtag') NOT BETWEEN 1 AND 512
   OR jsonb_typeof(binding->'afterEtag') IS DISTINCT FROM 'string' OR length(binding->>'afterEtag') NOT BETWEEN 1 AND 512
   OR (expected_member IS NOT NULL AND binding->>'member' IS DISTINCT FROM expected_member)
   OR (expected_member IS NULL AND coalesce(binding->>'member','') !~ '^serviceAccount:service-[1-9][0-9]*@gcp-sa-cloudtasks[.]iam[.]gserviceaccount[.]com$')
   THEN RETURN false; END IF;
  END LOOP;
 END IF;
 RETURN true;
END;
$function$
$object$;
 ELSIF encode(sha256(convert_to(actual,'UTF8')),'hex') NOT IN ('38a8ec11f7099b60c25ed7380f74144d5a14e0f8c42fca42e56ca58689eefa46') THEN
  RAISE EXCEPTION 'Unqualified schema drift: valid_erasure_gcp_files_upgrade_observation';
 END IF;
END
$object_guard$;

REVOKE ALL ON FUNCTION public."valid_erasure_gcp_files_upgrade_observation"(jsonb, jsonb) FROM PUBLIC;

DO $pod_414$
BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN GRANT EXECUTE ON FUNCTION public."valid_erasure_gcp_files_upgrade_observation"(jsonb, jsonb) TO service_role; END IF;
END
$pod_414$;

DO $object_guard$
DECLARE actual text;
BEGIN
 SELECT definition INTO actual FROM (SELECT pg_get_functiondef(p.oid) definition FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='valid_erasure_grant_release' AND pg_get_function_identity_arguments(p.oid)='r jsonb, receipt jsonb') observed;
 IF actual IS NULL THEN
  EXECUTE $object$CREATE OR REPLACE FUNCTION public.valid_erasure_grant_release(r jsonb, receipt jsonb)
 RETURNS boolean
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public'
AS $function$
 SELECT jsonb_typeof(receipt)='object'
 AND receipt - ARRAY['ownerId','attemptId','project','status']='{}'::jsonb
 AND receipt->>'ownerId'=r->>'ownerId' AND receipt->>'attemptId'=r->>'attemptId'
 AND receipt->>'project'=r->'registrySnapshot'->>'user_cloud_project'
 AND receipt->>'project' ~ '^[a-z][a-z0-9-]{4,61}[a-z0-9]$'
 AND receipt->>'status'='reserved'
 AND public.valid_erasure_account_receipt(r,'deletion',r->'accountErasure'->'deletion') IS TRUE;
$function$
$object$;
 ELSIF encode(sha256(convert_to(actual,'UTF8')),'hex') NOT IN ('11b5843638035e5e4ac935d43e74b143f4e653a27ed8b19332570307afe4a9a9') THEN
  RAISE EXCEPTION 'Unqualified schema drift: valid_erasure_grant_release';
 END IF;
END
$object_guard$;

REVOKE ALL ON FUNCTION public."valid_erasure_grant_release"(jsonb, jsonb) FROM PUBLIC;

DO $pod_414$
BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN GRANT EXECUTE ON FUNCTION public."valid_erasure_grant_release"(jsonb, jsonb) TO service_role; END IF;
END
$pod_414$;

DO $object_guard$
DECLARE actual text;
BEGIN
 SELECT definition INTO actual FROM (SELECT pg_get_functiondef(p.oid) definition FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='valid_erasure_kms_append' AND pg_get_function_identity_arguments(p.oid)='old_r jsonb, new_r jsonb') observed;
 IF actual IS NULL THEN
  EXECUTE $object$CREATE OR REPLACE FUNCTION public.valid_erasure_kms_append(old_r jsonb, new_r jsonb)
 RETURNS boolean
 LANGUAGE plpgsql
 IMMUTABLE
 SET search_path TO 'public'
AS $function$
DECLARE old_k jsonb; new_k jsonb; stage text; version_name text; prior jsonb; incoming jsonb;
BEGIN
 old_k:=coalesce(old_r->'kmsErasure','{}'::jsonb); new_k:=new_r->'kmsErasure';
 IF new_r - 'kmsErasure' IS DISTINCT FROM old_r - 'kmsErasure' OR jsonb_typeof(new_k) IS DISTINCT FROM 'object' THEN RETURN false; END IF;
 FOREACH stage IN ARRAY ARRAY['inventory','completion'] LOOP
  IF NOT (old_k ? stage) AND new_k - stage=old_k AND public.valid_erasure_kms_receipt(old_r,stage,new_k->stage) IS TRUE THEN RETURN true; END IF;
 END LOOP;
 IF new_k - 'versions' IS DISTINCT FROM old_k - 'versions' OR jsonb_typeof(new_k->'versions') IS DISTINCT FROM 'object' THEN RETURN false; END IF;
 FOR version_name,incoming IN SELECT * FROM jsonb_each(new_k->'versions') LOOP
  prior:=coalesce(old_k->'versions'->version_name,'{}'::jsonb);
  IF jsonb_typeof(incoming) IS DISTINCT FROM 'object' OR (new_k->'versions') - version_name IS DISTINCT FROM coalesce(old_k->'versions','{}'::jsonb) - version_name THEN CONTINUE; END IF;
  FOREACH stage IN ARRAY ARRAY['admission','acknowledgement','destruction'] LOOP
   IF NOT (prior ? stage) AND incoming - stage=prior
   AND incoming->stage->>'versionName'=version_name
   AND public.valid_erasure_kms_receipt(old_r,stage,incoming->stage) IS TRUE THEN RETURN true; END IF;
  END LOOP;
 END LOOP;
 RETURN false;
END;
$function$
$object$;
 ELSIF encode(sha256(convert_to(actual,'UTF8')),'hex') NOT IN ('a72f677c8751e37f2ca5f6fd2de0fd744243dfad2af31fd66c9d802135bf0bcf') THEN
  RAISE EXCEPTION 'Unqualified schema drift: valid_erasure_kms_append';
 END IF;
END
$object_guard$;

REVOKE ALL ON FUNCTION public."valid_erasure_kms_append"(jsonb, jsonb) FROM PUBLIC;

DO $pod_414$
BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN GRANT EXECUTE ON FUNCTION public."valid_erasure_kms_append"(jsonb, jsonb) TO service_role; END IF;
END
$pod_414$;

DO $object_guard$
DECLARE actual text;
BEGIN
 SELECT definition INTO actual FROM (SELECT pg_get_functiondef(p.oid) definition FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='valid_erasure_kms_receipt' AND pg_get_function_identity_arguments(p.oid)='r jsonb, stage text, receipt jsonb') observed;
 IF actual IS NULL THEN
  EXECUTE $object$CREATE OR REPLACE FUNCTION public.valid_erasure_kms_receipt(r jsonb, stage text, receipt jsonb)
 RETURNS boolean
 LANGUAGE plpgsql
 IMMUTABLE
 SET search_path TO 'public'
AS $function$
DECLARE obs jsonb; ident jsonb; inv jsonb; captured jsonb; version_name text; key_name text; kind text;
BEGIN
 IF stage IS NULL OR stage NOT IN ('inventory','admission','acknowledgement','destruction','completion')
 OR jsonb_typeof(receipt) IS DISTINCT FROM 'object'
 OR public.valid_erasure_bucket_receipt(r,'bucketDeletion',r->'bucketDeletion') IS DISTINCT FROM true THEN RETURN false; END IF;
 -- 956: every independently named mail resource must be deleted before key destruction.
 IF public.erasure_mail_resources_deleted(r) IS DISTINCT FROM true THEN RETURN false; END IF;
 inv:=r->'substrateInventory'; obs:=receipt->'resourceObservation'; ident:=obs->'identity';
 key_name:='projects/' || (r->'registrySnapshot'->>'user_cloud_project') || '/locations/' || (r->'registrySnapshot'->>'user_cloud_region') || '/keyRings/hushh-one/cryptoKeys/' || (obs->>'id');
 IF receipt->>'ownerId' IS DISTINCT FROM r->>'ownerId' OR receipt->>'attemptId' IS DISTINCT FROM r->>'attemptId'
 OR jsonb_typeof(obs) IS DISTINCT FROM 'object' OR obs - ARRAY['type','id','disposition','identity'] <> '{}'::jsonb
 OR obs->>'type' IS DISTINCT FROM 'kms_key' OR obs->>'disposition' IS DISTINCT FROM 'created'
 OR obs->>'id' IS NULL OR obs->>'id' !~ '^[A-Za-z0-9_-]{1,63}$'
 OR jsonb_typeof(ident) IS DISTINCT FROM 'object' OR ident - ARRAY['name','purpose','createTime'] <> '{}'::jsonb
 OR key_name IS NULL OR ident->>'name' IS DISTINCT FROM key_name OR ident->>'purpose' IS DISTINCT FROM 'ENCRYPT_DECRYPT'
 OR jsonb_typeof(ident->'createTime') IS DISTINCT FROM 'string' OR length(ident->>'createTime') NOT BETWEEN 1 AND 64
 OR (SELECT count(*) FROM jsonb_array_elements(inv->'plannedResources') x WHERE x->>'type'='kms_key') <> 1
 OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(inv->'plannedResources') x WHERE x->>'type'='kms_key' AND x->>'id'=obs->>'id')
 OR (SELECT count(*) FROM jsonb_array_elements(inv->'resourceObservations') x WHERE x=obs) <> 1 THEN RETURN false; END IF;
 IF stage='inventory' THEN
  IF receipt - ARRAY['ownerId','attemptId','resourceObservation','versionNames'] <> '{}'::jsonb
  OR jsonb_typeof(receipt->'versionNames') IS DISTINCT FROM 'array' THEN RETURN false; END IF;
  IF jsonb_array_length(receipt->'versionNames') > 32000 THEN RETURN false; END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(receipt->'versionNames') x WHERE jsonb_typeof(x) <> 'string'
    OR left(x #>> '{}',length(key_name || '/cryptoKeyVersions/')) <> key_name || '/cryptoKeyVersions/'
    OR substring(x #>> '{}' FROM length(key_name || '/cryptoKeyVersions/')+1) !~ '^[0-9]{1,20}$') THEN RETURN false; END IF;
  RETURN (SELECT count(*)=count(DISTINCT x) FROM jsonb_array_elements(receipt->'versionNames') x);
 END IF;
 captured:=r->'kmsErasure'->'inventory';
 IF public.valid_erasure_kms_receipt(r,'inventory',captured) IS DISTINCT FROM true
 OR receipt->'resourceObservation' IS DISTINCT FROM captured->'resourceObservation' THEN RETURN false; END IF;
 IF stage='completion' THEN
  IF receipt - 'status' IS DISTINCT FROM captured OR receipt->>'status' IS DISTINCT FROM 'destroyed' THEN RETURN false; END IF;
  FOR version_name IN SELECT jsonb_array_elements_text(captured->'versionNames') LOOP
   IF public.valid_erasure_kms_receipt(r,'destruction',r->'kmsErasure'->'versions'->version_name->'destruction') IS DISTINCT FROM true THEN RETURN false; END IF;
  END LOOP;
  RETURN true;
 END IF;
 version_name:=receipt->>'versionName';
 IF receipt - ARRAY['ownerId','attemptId','resourceObservation','versionName','status'] <> '{}'::jsonb
 OR version_name IS NULL OR NOT (captured->'versionNames' ? version_name) THEN RETURN false; END IF;
 IF stage='admission' THEN RETURN receipt->>'status'='admitted'; END IF;
 IF stage='destruction' THEN RETURN receipt->>'status'='destroyed'; END IF;
 RETURN receipt->>'status'='scheduled'
 AND public.valid_erasure_kms_receipt(r,'admission',r->'kmsErasure'->'versions'->version_name->'admission') IS TRUE;
END;
$function$
$object$;
 ELSIF encode(sha256(convert_to(actual,'UTF8')),'hex') NOT IN ('d0aa90c25eee793106f325983887305a032202012fe02ca74a55b4bb11b2eac2') THEN
  RAISE EXCEPTION 'Unqualified schema drift: valid_erasure_kms_receipt';
 END IF;
END
$object_guard$;

REVOKE ALL ON FUNCTION public."valid_erasure_kms_receipt"(jsonb, text, jsonb) FROM PUBLIC;

DO $pod_414$
BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN GRANT EXECUTE ON FUNCTION public."valid_erasure_kms_receipt"(jsonb, text, jsonb) TO service_role; END IF;
END
$pod_414$;

DO $object_guard$
DECLARE actual text;
BEGIN
 SELECT definition INTO actual FROM (SELECT pg_get_functiondef(p.oid) definition FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='valid_erasure_mail_append' AND pg_get_function_identity_arguments(p.oid)='before_record jsonb, after_record jsonb') observed;
 IF actual IS NULL THEN
  EXECUTE $object$CREATE OR REPLACE FUNCTION public.valid_erasure_mail_append(before_record jsonb, after_record jsonb)
 RETURNS boolean
 LANGUAGE plpgsql
 IMMUTABLE
 SET search_path TO 'public'
AS $function$
DECLARE kind text; stage text; old_mail jsonb; new_mail jsonb; old_kind jsonb; new_kind jsonb; resource_id text; old_resources jsonb; new_resources jsonb; prior jsonb; incoming jsonb;
BEGIN
 old_mail:=coalesce(before_record->'mailErasure','{}'::jsonb); new_mail:=after_record->'mailErasure';
 IF jsonb_typeof(new_mail) IS DISTINCT FROM 'object' OR after_record-'mailErasure' IS DISTINCT FROM before_record-'mailErasure' THEN RETURN false; END IF;
 FOREACH kind IN ARRAY ARRAY['cloud_scheduler_job','pubsub_subscription','pubsub_topic'] LOOP
  old_kind:=coalesce(old_mail->kind,'{}'::jsonb); new_kind:=new_mail->kind;
  -- 956: append one stage of one exact resource, preserving every sibling.
  old_resources:=coalesce(old_kind->'resources','{}'::jsonb); new_resources:=new_kind->'resources';
  IF new_kind-'resources'=old_kind-'resources' AND jsonb_typeof(new_resources)='object'
   AND new_mail-kind=old_mail-kind THEN
   FOR resource_id,incoming IN SELECT * FROM jsonb_each(new_resources) LOOP
    prior:=coalesce(old_resources->resource_id,'{}'::jsonb);
    IF new_resources-resource_id IS DISTINCT FROM old_resources-resource_id THEN CONTINUE; END IF;
    FOREACH stage IN ARRAY ARRAY['admission','acknowledgement','deletion'] LOOP
     IF NOT (prior ? stage) AND incoming-stage=prior
      AND incoming->stage->'resourceObservation'->>'id'=resource_id
      AND public.valid_erasure_mail_receipt(before_record,kind,stage,incoming->stage) IS TRUE THEN RETURN true; END IF;
    END LOOP;
   END LOOP;
  END IF;
  FOREACH stage IN ARRAY ARRAY['admission','acknowledgement','deletion'] LOOP
   IF NOT (old_kind ? stage) AND new_kind ? stage AND new_mail-kind=old_mail-kind
      AND new_kind-stage=old_kind AND public.valid_erasure_mail_receipt(before_record,kind,stage,new_kind->stage) IS TRUE THEN RETURN true; END IF;
  END LOOP;
 END LOOP;
 RETURN false;
END;
$function$
$object$;
 ELSIF encode(sha256(convert_to(actual,'UTF8')),'hex') NOT IN ('2870b47d43917b17b0f6438c731411f70e7553f413aba0885801da1580ff755f') THEN
  RAISE EXCEPTION 'Unqualified schema drift: valid_erasure_mail_append';
 END IF;
END
$object_guard$;

REVOKE ALL ON FUNCTION public."valid_erasure_mail_append"(jsonb, jsonb) FROM PUBLIC;

DO $pod_414$
BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN GRANT EXECUTE ON FUNCTION public."valid_erasure_mail_append"(jsonb, jsonb) TO service_role; END IF;
END
$pod_414$;

DO $object_guard$
DECLARE actual text;
BEGIN
 SELECT definition INTO actual FROM (SELECT pg_get_functiondef(p.oid) definition FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='valid_erasure_mail_receipt' AND pg_get_function_identity_arguments(p.oid)='reservation jsonb, kind text, stage text, receipt jsonb') observed;
 IF actual IS NULL THEN
  EXECUTE $object$CREATE OR REPLACE FUNCTION public.valid_erasure_mail_receipt(reservation jsonb, kind text, stage text, receipt jsonb)
 RETURNS boolean
 LANGUAGE plpgsql
 IMMUTABLE
 SET search_path TO 'public'
AS $function$
DECLARE inventory jsonb; observation jsonb; identity jsonb; project text; resource_name text; dependency text; admitted jsonb; dependency_resource jsonb; states jsonb; terms jsonb; origin text;
BEGIN
 IF public.valid_erasure_writer_receipt(reservation,'writerDisabled',reservation->'writerDisabled') IS DISTINCT FROM true
    OR kind IS NULL OR kind NOT IN ('cloud_scheduler_job','pubsub_subscription','pubsub_topic')
    OR stage IS NULL OR stage NOT IN ('admission','acknowledgement','deletion')
    OR jsonb_typeof(receipt) IS DISTINCT FROM 'object' THEN RETURN false; END IF;
 inventory:=reservation->'substrateInventory'; observation:=receipt->'resourceObservation'; identity:=observation->'identity';
 project:=reservation->'registrySnapshot'->>'user_cloud_project';
 terms:=reservation->'registrySnapshot'->'backend_metadata'->'notificationCheckpoint';
 IF receipt->>'ownerId' IS DISTINCT FROM reservation->>'ownerId'
    OR receipt->>'attemptId' IS DISTINCT FROM reservation->>'attemptId'
    OR receipt - ARRAY['ownerId','attemptId','resourceObservation','status'] <> '{}'::jsonb
    OR jsonb_typeof(observation) IS DISTINCT FROM 'object'
    OR observation - ARRAY['type','id','disposition','identity'] <> '{}'::jsonb
    OR observation->>'type' IS DISTINCT FROM kind OR observation->>'disposition' IS DISTINCT FROM 'created'
    OR observation->>'id' IS NULL OR (observation->>'id' !~ '^[A-Za-z0-9_.~-]{1,255}$' AND (
      kind='pubsub_topic' AND terms->>'ownerId'=reservation->>'ownerId'
      AND terms->>'hushhId'=reservation->>'hushhId' AND terms->>'project'=project
      AND observation->>'id'='projects/'||(terms->'plan'->>'oauthProject')||'/topics/one-mail-'||
        left(trim(both '-' from regexp_replace(lower(reservation->>'hushhId'),'[^a-z0-9-]+','-','g')),40)) IS NOT TRUE)
    OR jsonb_typeof(identity) IS DISTINCT FROM 'object' THEN RETURN false; END IF;
 resource_name := CASE WHEN kind='pubsub_topic' AND starts_with(observation->>'id','projects/')
 THEN observation->>'id' ELSE 'projects/' || project || '/' || CASE kind
    WHEN 'cloud_scheduler_job' THEN 'locations/' || (reservation->'registrySnapshot'->>'user_cloud_region') || '/jobs/'
    WHEN 'pubsub_subscription' THEN 'subscriptions/' ELSE 'topics/' END || (observation->>'id') END;
 IF resource_name IS NULL OR identity->>'name' IS DISTINCT FROM resource_name THEN RETURN false; END IF;
 IF starts_with(observation->>'id','projects/') AND public.operator_mail_grants_qualified(reservation,observation->>'id') IS NOT TRUE THEN RETURN false; END IF;
 IF (SELECT count(*) FROM jsonb_array_elements(inventory->'plannedResources') AS r WHERE r->>'type'=kind AND r->>'id'=observation->>'id') <> 1
    OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(inventory->'plannedResources') AS r WHERE r->>'type'=kind AND r->>'id'=observation->>'id')
    OR (SELECT count(*) FROM jsonb_array_elements(inventory->'resourceObservations') AS r WHERE r=observation) <> 1 THEN RETURN false; END IF;
 IF kind='pubsub_topic' AND identity - 'name' <> '{}'::jsonb THEN RETURN false; END IF;
 -- 956: a direct subscription may attach only to this operation's operator topic.
 terms:=reservation->'registrySnapshot'->'backend_metadata'->'notificationCheckpoint';
 IF kind='pubsub_subscription' AND (identity - ARRAY['name','topic'] <> '{}'::jsonb
    OR (EXISTS (SELECT 1 FROM jsonb_array_elements(inventory->'plannedResources') AS r WHERE r->>'type'='pubsub_topic' AND identity->>'topic'='projects/' || project || '/topics/' || (r->>'id'))
      OR (terms->>'ownerId'=reservation->>'ownerId' AND terms->>'hushhId'=reservation->>'hushhId' AND terms->>'project'=project
       AND observation->>'id'='one-mail-'||left(trim(both '-' from regexp_replace(lower(reservation->>'hushhId'),'[^a-z0-9-]+','-','g')),40)||'-direct-sub'
       AND identity->>'topic'='projects/'||(terms->'plan'->>'oauthProject')||'/topics/one-mail-'||left(trim(both '-' from regexp_replace(lower(reservation->>'hushhId'),'[^a-z0-9-]+','-','g')),40))) IS DISTINCT FROM true) THEN RETURN false; END IF;
 IF kind='cloud_scheduler_job' AND NOT (identity ? 'httpTarget') AND (identity - ARRAY['name','pubsubTarget','schedule','timeZone'] <> '{}'::jsonb
    OR jsonb_typeof(identity->'pubsubTarget') IS DISTINCT FROM 'object'
    OR (identity->'pubsubTarget') - 'topicName' <> '{}'::jsonb
    OR jsonb_typeof(identity->'schedule') IS DISTINCT FROM 'string' OR length(identity->>'schedule') NOT BETWEEN 1 AND 128
    OR jsonb_typeof(identity->'timeZone') IS DISTINCT FROM 'string' OR length(identity->>'timeZone') NOT BETWEEN 1 AND 128
    OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(inventory->'plannedResources') AS r WHERE r->>'type'='pubsub_topic' AND identity->'pubsubTarget'->>'topicName'='projects/' || project || '/topics/' || (r->>'id'))) THEN RETURN false; END IF;
 IF kind='cloud_scheduler_job' AND identity ? 'httpTarget' THEN
  origin:=identity->'httpTarget'->'oidcToken'->>'audience';
  IF terms->>'ownerId' IS DISTINCT FROM reservation->>'ownerId' OR terms->>'project' IS DISTINCT FROM project
   OR terms->>'serviceUid' IS DISTINCT FROM reservation->'registrySnapshot'->'backend_metadata'->>'serviceUid'
   OR coalesce(origin,'') !~ '^https://[a-z0-9][a-z0-9.-]+$'
   OR identity IS DISTINCT FROM jsonb_build_object('name',resource_name,'schedule','0 4 * * *','timeZone','Etc/UTC',
      'httpTarget',jsonb_build_object('uri',origin||'/api/one/pod/maintenance/tick','httpMethod','POST',
       'oidcToken',jsonb_build_object('audience',origin,'serviceAccountEmail',terms->'plan'->>'runtimeAccount')))
   OR origin IS DISTINCT FROM rtrim(reservation->'registrySnapshot'->'backend_metadata'->>'url','/') THEN RETURN false; END IF;
 END IF;
 IF stage='admission' THEN
    dependency := CASE kind WHEN 'pubsub_subscription' THEN 'cloud_scheduler_job' WHEN 'pubsub_topic' THEN 'pubsub_subscription' ELSE NULL END;
    -- 956: every dependent resource needs its own qualified deletion.
    IF dependency IS NOT NULL THEN
     FOR dependency_resource IN SELECT value FROM jsonb_array_elements(inventory->'plannedResources') x WHERE x->>'type'=dependency LOOP
      states:=public.erasure_mail_resource_state(reservation,dependency,dependency_resource->>'id');
      IF public.valid_erasure_mail_receipt(reservation,dependency,'deletion',states->'deletion') IS DISTINCT FROM true THEN RETURN false; END IF;
     END LOOP;
    END IF;
    RETURN receipt->>'status'='admitted';
 END IF;
 states:=public.erasure_mail_resource_state(reservation,kind,observation->>'id');
 admitted:=states->'admission';
 IF public.valid_erasure_mail_receipt(reservation,kind,'admission',admitted) IS DISTINCT FROM true
    OR receipt - 'status' IS DISTINCT FROM admitted - 'status' THEN RETURN false; END IF;
 IF stage='acknowledgement' THEN RETURN receipt->>'status'='acknowledged'; END IF;
 RETURN receipt->>'status'='absent' AND public.valid_erasure_mail_receipt(reservation,kind,'acknowledgement',states->'acknowledgement');
END;
$function$
$object$;
 ELSIF encode(sha256(convert_to(actual,'UTF8')),'hex') NOT IN ('e11aa98f323fb42d4b5724f23e20e5b86f26dc77a4f5d2506266e31cdfd84fc2') THEN
  RAISE EXCEPTION 'Unqualified schema drift: valid_erasure_mail_receipt';
 END IF;
END
$object_guard$;

REVOKE ALL ON FUNCTION public."valid_erasure_mail_receipt"(jsonb, text, text, jsonb) FROM PUBLIC;

DO $pod_414$
BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN GRANT EXECUTE ON FUNCTION public."valid_erasure_mail_receipt"(jsonb, text, text, jsonb) TO service_role; END IF;
END
$pod_414$;

DO $object_guard$
DECLARE actual text;
BEGIN
 SELECT definition INTO actual FROM (SELECT pg_get_functiondef(p.oid) definition FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='valid_erasure_memory_binding' AND pg_get_function_identity_arguments(p.oid)='reservation jsonb, receipt jsonb') observed;
 IF actual IS NULL THEN
  EXECUTE $object$CREATE OR REPLACE FUNCTION public.valid_erasure_memory_binding(reservation jsonb, receipt jsonb)
 RETURNS boolean
 LANGUAGE plpgsql
 IMMUTABLE
 SET search_path TO 'public'
AS $function$
DECLARE
  memory jsonb := receipt->'memoryBinding';
  incarnation jsonb := memory->'engineIncarnation';
  snapshot jsonb := reservation->'registrySnapshot';
  key text;
BEGIN
  IF jsonb_typeof(receipt) IS DISTINCT FROM 'object'
     OR receipt - ARRAY['hushhId','attemptId','service','serviceUid','revision','memoryBinding'] <> '{}'::jsonb
     OR reservation->>'phase' IS DISTINCT FROM 'reserved'
     OR reservation->>'version' IS DISTINCT FROM '1'
     OR receipt->>'hushhId' IS DISTINCT FROM reservation->>'hushhId'
     OR receipt->>'attemptId' IS DISTINCT FROM reservation->>'attemptId'
     OR snapshot->>'user_id' IS DISTINCT FROM reservation->>'ownerId'
     OR snapshot->>'status' IS DISTINCT FROM 'provisioned'
     OR snapshot->'backend_metadata' ? 'upgradeLease'
     OR receipt->>'serviceUid' IS DISTINCT FROM snapshot->'backend_metadata'->>'serviceUid'
     OR receipt->>'service' IS DISTINCT FROM coalesce(snapshot->'backend_metadata'->>'service',snapshot->>'external_agent_id')
     OR jsonb_typeof(memory) IS DISTINCT FROM 'object'
     OR memory - ARRAY['project','location','engineId','engineIncarnation','generationProtocol','creationProvenance'] <> '{}'::jsonb
     OR memory->'generationProtocol' IS DISTINCT FROM '2'::jsonb
     OR jsonb_typeof(incarnation) IS DISTINCT FROM 'object'
     OR incarnation - ARRAY['name','createTime'] <> '{}'::jsonb THEN RETURN false; END IF;
  FOREACH key IN ARRAY ARRAY['hushhId','attemptId','service','serviceUid','revision'] LOOP
    IF jsonb_typeof(receipt->key) IS DISTINCT FROM 'string'
       OR length(receipt->>key) NOT BETWEEN 1 AND 128
       OR receipt->>key <> btrim(receipt->>key)
       OR receipt->>key ~ '[[:cntrl:]]' THEN RETURN false; END IF;
  END LOOP;
  IF left(receipt->>'revision',length(receipt->>'service')+1) <> (receipt->>'service') || '-' THEN RETURN false; END IF;
  FOREACH key IN ARRAY ARRAY['project','location','engineId'] LOOP
    IF jsonb_typeof(memory->key) IS DISTINCT FROM 'string'
       OR length(memory->>key) NOT BETWEEN 1 AND 256
       OR memory->>key !~ '^[A-Za-z0-9_-]+$' THEN RETURN false; END IF;
  END LOOP;
  IF jsonb_typeof(incarnation->'name') IS DISTINCT FROM 'string'
     OR length(incarnation->>'name') NOT BETWEEN 1 AND 1024
     OR incarnation->>'name' !~ '^projects/[A-Za-z0-9_-]+/locations/[A-Za-z0-9_-]+/reasoningEngines/[A-Za-z0-9_-]+$'
     OR split_part(incarnation->>'name','/',4) <> memory->>'location'
     OR split_part(incarnation->>'name','/',6) <> memory->>'engineId'
     OR jsonb_typeof(incarnation->'createTime') IS DISTINCT FROM 'string'
     OR length(incarnation->>'createTime') NOT BETWEEN 1 AND 64
     OR incarnation->>'createTime' !~ '^.+T.+(Z|[+-][0-9]{2}:[0-9]{2})$' THEN RETURN false; END IF;
  IF memory ? 'creationProvenance' AND (
     jsonb_typeof(memory->'creationProvenance') IS DISTINCT FROM 'object'
     OR (memory->'creationProvenance') - ARRAY['version','reservationGeneration','engineIncarnation'] <> '{}'::jsonb
     OR memory->'creationProvenance'->'version' IS DISTINCT FROM '1'::jsonb
     OR jsonb_typeof(memory->'creationProvenance'->'reservationGeneration') IS DISTINCT FROM 'number'
     OR coalesce(memory->'creationProvenance'->>'reservationGeneration','') !~ '^[1-9][0-9]*$'
     OR memory->'creationProvenance'->'engineIncarnation' IS DISTINCT FROM incarnation
  ) THEN RETURN false; END IF;
  PERFORM (incarnation->>'createTime')::timestamptz;
  RETURN true;
EXCEPTION WHEN invalid_datetime_format OR datetime_field_overflow THEN RETURN false;
END;
$function$
$object$;
 ELSIF encode(sha256(convert_to(actual,'UTF8')),'hex') NOT IN ('3e6f72daf26d7532d6764d190cb6337410e3c97f845dbe9dfd10907dc5d5a8dd') THEN
  RAISE EXCEPTION 'Unqualified schema drift: valid_erasure_memory_binding';
 END IF;
END
$object_guard$;

REVOKE ALL ON FUNCTION public."valid_erasure_memory_binding"(jsonb, jsonb) FROM PUBLIC;

DO $pod_414$
BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN GRANT EXECUTE ON FUNCTION public."valid_erasure_memory_binding"(jsonb, jsonb) TO service_role; END IF;
END
$pod_414$;

DO $object_guard$
DECLARE actual text;
BEGIN
 SELECT definition INTO actual FROM (SELECT pg_get_functiondef(p.oid) definition FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='valid_erasure_memory_deletion' AND pg_get_function_identity_arguments(p.oid)='reservation jsonb, receipt jsonb') observed;
 IF actual IS NULL THEN
  EXECUTE $object$CREATE OR REPLACE FUNCTION public.valid_erasure_memory_deletion(reservation jsonb, receipt jsonb)
 RETURNS boolean
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public'
AS $function$
 SELECT coalesce(jsonb_typeof(receipt)='object'
   AND receipt->>'status'='provider_deleted'
   AND receipt - 'status' = reservation->'memoryBinding'
   AND public.valid_erasure_memory_binding(reservation,receipt - 'status')
   AND jsonb_typeof(reservation->'memoryBinding'->'memoryBinding'->'creationProvenance')='object',false);
$function$
$object$;
 ELSIF encode(sha256(convert_to(actual,'UTF8')),'hex') NOT IN ('2fd0b73d6431b32f822cb201ec9705211d79e72392c9376bc88677d7b860fc0b') THEN
  RAISE EXCEPTION 'Unqualified schema drift: valid_erasure_memory_deletion';
 END IF;
END
$object_guard$;

REVOKE ALL ON FUNCTION public."valid_erasure_memory_deletion"(jsonb, jsonb) FROM PUBLIC;

DO $pod_414$
BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN GRANT EXECUTE ON FUNCTION public."valid_erasure_memory_deletion"(jsonb, jsonb) TO service_role; END IF;
END
$pod_414$;

DO $object_guard$
DECLARE actual text;
BEGIN
 SELECT definition INTO actual FROM (SELECT pg_get_functiondef(p.oid) definition FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='valid_erasure_never_hosted_append' AND pg_get_function_identity_arguments(p.oid)='owner_id text, old_r jsonb, new_r jsonb') observed;
 IF actual IS NULL THEN
  EXECUTE $object$CREATE OR REPLACE FUNCTION public.valid_erasure_never_hosted_append(owner_id text, old_r jsonb, new_r jsonb)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public'
AS $function$
BEGIN
 IF jsonb_typeof(old_r) IS DISTINCT FROM 'object' OR jsonb_typeof(new_r) IS DISTINCT FROM 'object' THEN
  RETURN false; END IF;
 RETURN coalesce(old_r - ARRAY['version','ownerId','attemptId','hushhId','phase','registrySnapshot']='{}'::jsonb
  AND new_r ?& ARRAY['neverHosted','grantRelease']
  AND new_r - ARRAY['neverHosted','grantRelease']=old_r
  AND public.erasure_never_hosted_admitted(owner_id,new_r) IS TRUE, false);
END;
$function$
$object$;
 ELSIF encode(sha256(convert_to(actual,'UTF8')),'hex') NOT IN ('c18e728b6f0e17a96e0bac7396428894a541deecd9500115dda9caaac2e94000') THEN
  RAISE EXCEPTION 'Unqualified schema drift: valid_erasure_never_hosted_append';
 END IF;
END
$object_guard$;

REVOKE ALL ON FUNCTION public."valid_erasure_never_hosted_append"(text, jsonb, jsonb) FROM PUBLIC;

DO $pod_414$
BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN GRANT EXECUTE ON FUNCTION public."valid_erasure_never_hosted_append"(text, jsonb, jsonb) TO service_role; END IF;
END
$pod_414$;

DO $object_guard$
DECLARE actual text;
BEGIN
 SELECT definition INTO actual FROM (SELECT pg_get_functiondef(p.oid) definition FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='valid_erasure_notification_observation' AND pg_get_function_identity_arguments(p.oid)='reservation jsonb, observation jsonb') observed;
 IF actual IS NULL THEN
  EXECUTE $object$CREATE OR REPLACE FUNCTION public.valid_erasure_notification_observation(reservation jsonb, observation jsonb)
 RETURNS boolean
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public'
AS $function$
 SELECT reservation->>'ownerId'=reservation->'registrySnapshot'->>'user_id'
 AND observation->>'phase'='observed'
 AND reservation->'registrySnapshot'->'backend_metadata'->'notificationCheckpoint'->>'phase'='intent'
 AND public.valid_personal_agent_notification_checkpoint(reservation->'registrySnapshot',observation,
  reservation->'registrySnapshot'->'backend_metadata'->'notificationCheckpoint');
$function$
$object$;
 ELSIF encode(sha256(convert_to(actual,'UTF8')),'hex') NOT IN ('9baddcec5411cc43c0ca9b03fa7433b5f64a6eb82e08a30465a46e1ab1797baa') THEN
  RAISE EXCEPTION 'Unqualified schema drift: valid_erasure_notification_observation';
 END IF;
END
$object_guard$;

REVOKE ALL ON FUNCTION public."valid_erasure_notification_observation"(jsonb, jsonb) FROM PUBLIC;

DO $pod_414$
BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN GRANT EXECUTE ON FUNCTION public."valid_erasure_notification_observation"(jsonb, jsonb) TO service_role; END IF;
END
$pod_414$;

DO $object_guard$
DECLARE actual text;
BEGIN
 SELECT definition INTO actual FROM (SELECT pg_get_functiondef(p.oid) definition FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='valid_erasure_owner_access' AND pg_get_function_identity_arguments(p.oid)='reservation jsonb, receipt jsonb') observed;
 IF actual IS NULL THEN
  EXECUTE $object$CREATE OR REPLACE FUNCTION public.valid_erasure_owner_access(reservation jsonb, receipt jsonb)
 RETURNS boolean
 LANGUAGE plpgsql
 IMMUTABLE
 SET search_path TO 'public'
AS $function$
DECLARE
  snapshot jsonb := reservation->'registrySnapshot';
  agent jsonb := receipt->'agentErased';
  vault jsonb := receipt->'keyVault';
  grp text;
  days text;
BEGIN
  -- Types first, each on its own: a jsonb operator on the wrong type raises.
  IF jsonb_typeof(receipt) IS DISTINCT FROM 'object'
     OR jsonb_typeof(agent) IS DISTINCT FROM 'object'
     OR jsonb_typeof(vault) IS DISTINCT FROM 'object'
     OR jsonb_typeof(snapshot) IS DISTINCT FROM 'object' THEN RETURN false; END IF;
  IF receipt - ARRAY['version','tenantId','subscriptionId','resourceGroup','agentErased',
       'agentAccessRevoked','husshAccessRevoked','remainingResources','keyVault','nextStep'] <> '{}'::jsonb
     OR NOT receipt ?& ARRAY['version','tenantId','subscriptionId','resourceGroup','agentErased',
       'agentAccessRevoked','husshAccessRevoked','remainingResources','keyVault','nextStep']
     OR pg_column_size(receipt) > 65536
     OR receipt->'version' IS DISTINCT FROM '1'::jsonb
     OR reservation->>'phase' IS DISTINCT FROM 'reserved'
     OR reservation->>'version' IS DISTINCT FROM '1'
     OR snapshot->>'user_id' IS DISTINCT FROM reservation->>'ownerId'
     OR snapshot->>'status' IS DISTINCT FROM 'provisioned'
     OR snapshot->>'deployment_target' IS DISTINCT FROM 'user_azure'
     OR snapshot->'backend_metadata' ? 'upgradeLease'
     OR receipt->>'tenantId' IS DISTINCT FROM snapshot->>'user_cloud_tenant_id'
     OR receipt->>'subscriptionId' IS DISTINCT FROM snapshot->>'user_cloud_subscription_id'
     OR receipt->>'resourceGroup' IS DISTINCT FROM snapshot->>'user_cloud_resource_group'
  THEN RETURN false; END IF;
  -- The pod's own confirmation, exactly as checkpointed before anything was revoked.
  IF public.valid_erasure_owner_access_checkpoint(reservation, reservation->'agentCryptoErase')
       IS NOT TRUE
     OR agent IS DISTINCT FROM reservation->'agentCryptoErase'->'agentErased' THEN RETURN false; END IF;
  -- Every named resource lies inside the person's own resource group.
  IF jsonb_typeof(receipt->'agentAccessRevoked') IS DISTINCT FROM 'array'
     OR jsonb_typeof(receipt->'husshAccessRevoked') IS DISTINCT FROM 'array'
     OR jsonb_typeof(receipt->'remainingResources') IS DISTINCT FROM 'array' THEN RETURN false; END IF;
  grp := lower('/subscriptions/' || (receipt->>'subscriptionId') || '/resourcegroups/' || (receipt->>'resourceGroup'));
  IF EXISTS (
    SELECT 1
    FROM unnest(ARRAY['agentAccessRevoked','husshAccessRevoked','remainingResources']) AS field,
         jsonb_array_elements(receipt->field) AS element
    WHERE jsonb_typeof(element) IS DISTINCT FROM 'string'
       OR length(element #>> '{}') > 1024
       OR NOT (lower(element #>> '{}') = grp OR left(lower(element #>> '{}'), length(grp) + 1) = grp || '/')
  ) OR NOT EXISTS (
    SELECT 1 FROM jsonb_array_elements_text(receipt->'remainingResources') AS remaining
    WHERE lower(remaining) = grp
  ) THEN RETURN false; END IF;
  days := vault->>'softDeleteRetentionDays';
  IF vault - ARRAY['name','purgeProtection','softDeleteRetentionDays','earliestPurgeIfDeletedToday'] <> '{}'::jsonb
     OR jsonb_typeof(vault->'name') IS DISTINCT FROM 'string'
     OR coalesce(vault->>'name','') !~ '^[a-z0-9-]{3,24}$'
     OR vault->'purgeProtection' IS DISTINCT FROM 'true'::jsonb
     OR jsonb_typeof(vault->'softDeleteRetentionDays') IS DISTINCT FROM 'number'
     OR coalesce(days,'') !~ '^[0-9]{1,2}$'
     OR coalesce(vault->>'earliestPurgeIfDeletedToday','') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
     OR jsonb_typeof(receipt->'nextStep') IS DISTINCT FROM 'string'
     OR length(receipt->>'nextStep') NOT BETWEEN 1 AND 1000
     OR position(lower(receipt->>'resourceGroup') IN lower(receipt->>'nextStep')) = 0
  THEN RETURN false; END IF;
  IF days::int NOT BETWEEN 7 AND 90 THEN RETURN false; END IF;
  PERFORM (vault->>'earliestPurgeIfDeletedToday')::date;
  RETURN true;
EXCEPTION WHEN invalid_datetime_format OR datetime_field_overflow THEN RETURN false;
END;
$function$
$object$;
 ELSIF encode(sha256(convert_to(actual,'UTF8')),'hex') NOT IN ('a6a48db5aab7bd5b2593b136483da8f05b030a1eddd6b0680d9263c1f715c3ee') THEN
  RAISE EXCEPTION 'Unqualified schema drift: valid_erasure_owner_access';
 END IF;
END
$object_guard$;

REVOKE ALL ON FUNCTION public."valid_erasure_owner_access"(jsonb, jsonb) FROM PUBLIC;

DO $pod_414$
BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN GRANT EXECUTE ON FUNCTION public."valid_erasure_owner_access"(jsonb, jsonb) TO service_role; END IF;
END
$pod_414$;

DO $object_guard$
DECLARE actual text;
BEGIN
 SELECT definition INTO actual FROM (SELECT pg_get_functiondef(p.oid) definition FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='valid_erasure_owner_access_checkpoint' AND pg_get_function_identity_arguments(p.oid)='reservation jsonb, checkpoint jsonb') observed;
 IF actual IS NULL THEN
  EXECUTE $object$CREATE OR REPLACE FUNCTION public.valid_erasure_owner_access_checkpoint(reservation jsonb, checkpoint jsonb)
 RETURNS boolean
 LANGUAGE plpgsql
 IMMUTABLE
 SET search_path TO 'public'
AS $function$
DECLARE
  snapshot jsonb := reservation->'registrySnapshot';
  agent jsonb := checkpoint->'agentErased';
  resume jsonb := checkpoint->'resume';
BEGIN
  -- Types first, each on its own: a jsonb operator on the wrong type raises.
  IF jsonb_typeof(checkpoint) IS DISTINCT FROM 'object'
     OR jsonb_typeof(agent) IS DISTINCT FROM 'object'
     OR jsonb_typeof(resume) IS DISTINCT FROM 'object'
     OR jsonb_typeof(snapshot) IS DISTINCT FROM 'object' THEN RETURN false; END IF;
  IF checkpoint - ARRAY['agentErased','resume'] <> '{}'::jsonb
     OR pg_column_size(checkpoint) > 8192
     OR reservation->>'phase' IS DISTINCT FROM 'reserved'
     OR reservation->>'version' IS DISTINCT FROM '1'
     OR snapshot->>'user_id' IS DISTINCT FROM reservation->>'ownerId'
     OR snapshot->>'status' IS DISTINCT FROM 'provisioned'
     OR snapshot->>'deployment_target' IS DISTINCT FROM 'user_azure'
     OR snapshot->'backend_metadata' ? 'upgradeLease'
  THEN RETURN false; END IF;
  -- What revocation needs without reading the agent: the setup nonce, nothing else.
  IF resume - ARRAY['setupNonce'] <> '{}'::jsonb
     OR jsonb_typeof(resume->'setupNonce') IS DISTINCT FROM 'string'
     OR resume->>'setupNonce' !~ '^[0-9a-f]{16}$' THEN RETURN false; END IF;
  -- The pod's own confirmation, bound to this attempt and the recorded incarnation.
  IF agent - ARRAY['status','erased','hushhId','attemptId','service','serviceUid','revision',
       'deleted','alreadyAbsent','records',
       'providerRevoked','providerUnconfirmed','providerUnavailable','providerCoverage'] <> '{}'::jsonb
     OR agent->'erased' IS DISTINCT FROM 'true'::jsonb
     OR agent->>'status' IS DISTINCT FROM 'erased'
     OR agent->>'attemptId' IS DISTINCT FROM reservation->>'attemptId'
     OR agent->>'hushhId' IS DISTINCT FROM reservation->>'hushhId'
     OR agent->>'serviceUid' IS DISTINCT FROM snapshot->'backend_metadata'->>'serviceUid'
     OR jsonb_typeof(agent->'service') IS DISTINCT FROM 'string'
     OR jsonb_typeof(agent->'revision') IS DISTINCT FROM 'string'
     OR jsonb_typeof(agent->'deleted') IS DISTINCT FROM 'number'
     OR jsonb_typeof(agent->'alreadyAbsent') IS DISTINCT FROM 'number'
     OR jsonb_typeof(agent->'records') IS DISTINCT FROM 'number'
     OR coalesce(agent->>'deleted','') !~ '^[0-9]{1,9}$'
     OR coalesce(agent->>'alreadyAbsent','') !~ '^[0-9]{1,9}$'
     OR coalesce(agent->>'records','') !~ '^[0-9]{1,9}$' THEN RETURN false; END IF;
  -- Legacy checkpoints remain readable with UNKNOWN provider outcomes.
  -- Retain every new outcome before revoking access; incomplete revocation is
  -- evidence to preserve, never proof that provider cleanup has completed.
  IF agent ? 'providerCoverage' AND agent->'providerCoverage' IS DISTINCT FROM
       '"connector_history_v1"'::jsonb THEN RETURN false; END IF;
  IF agent ?| ARRAY['providerRevoked','providerUnconfirmed','providerUnavailable','providerCoverage'] THEN
    IF NOT agent ?& ARRAY['providerRevoked','providerUnconfirmed','providerUnavailable']
       OR jsonb_typeof(agent->'providerRevoked') IS DISTINCT FROM 'number'
       OR jsonb_typeof(agent->'providerUnconfirmed') IS DISTINCT FROM 'number'
       OR jsonb_typeof(agent->'providerUnavailable') IS DISTINCT FROM 'number'
       OR coalesce(agent->>'providerRevoked','') !~ '^[0-9]{1,3}$'
       OR coalesce(agent->>'providerUnconfirmed','') !~ '^[0-9]{1,3}$'
       OR coalesce(agent->>'providerUnavailable','') !~ '^[01]$'
    THEN RETURN false; END IF;
    IF (agent->>'providerRevoked')::int + (agent->>'providerUnconfirmed')::int > 128
       OR ((agent->>'providerUnavailable')::int = 1 AND
         ((agent->>'providerRevoked')::int <> 0 OR (agent->>'providerUnconfirmed')::int <> 0))
    THEN RETURN false; END IF;
  END IF;
  RETURN true;
END;
$function$
$object$;
 ELSIF encode(sha256(convert_to(actual,'UTF8')),'hex') NOT IN ('c88389b99d88da2141868a58b9377d82a7f03b8adc096bc5262797856e7331e0') THEN
  RAISE EXCEPTION 'Unqualified schema drift: valid_erasure_owner_access_checkpoint';
 END IF;
END
$object_guard$;

REVOKE ALL ON FUNCTION public."valid_erasure_owner_access_checkpoint"(jsonb, jsonb) FROM PUBLIC;

DO $pod_414$
BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN GRANT EXECUTE ON FUNCTION public."valid_erasure_owner_access_checkpoint"(jsonb, jsonb) TO service_role; END IF;
END
$pod_414$;

DO $object_guard$
DECLARE actual text;
BEGIN
 SELECT definition INTO actual FROM (SELECT pg_get_functiondef(p.oid) definition FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='valid_erasure_provision_ack' AND pg_get_function_identity_arguments(p.oid)='reservation jsonb, receipt jsonb') observed;
 IF actual IS NULL THEN
  EXECUTE $object$CREATE OR REPLACE FUNCTION public.valid_erasure_provision_ack(reservation jsonb, receipt jsonb)
 RETURNS boolean
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public'
AS $function$
 SELECT coalesce(
   jsonb_typeof(receipt)='object' AND octet_length(receipt::text)<=65536
   AND receipt->>'version'='1' AND jsonb_typeof(receipt->'evidence')='object'
   AND receipt->>'ownerId'=reservation->>'ownerId'
   AND receipt->>'attemptId'=reservation->'registrySnapshot'->'backend_metadata'->'provisionAttempt'->>'attemptId'
   AND receipt->>'expectedPhase'=CASE
     WHEN reservation->'registrySnapshot'->'backend_metadata'->'provisionAttempt'->>'phase'='failed'
     THEN reservation->'registrySnapshot'->'backend_metadata'->'provisionAttempt'->>'failedFrom'
     ELSE reservation->'registrySnapshot'->'backend_metadata'->'provisionAttempt'->>'phase' END
   AND ((receipt->>'expectedPhase'='reserved' AND receipt->>'nextPhase'='substrate')
     OR (receipt->>'expectedPhase'='host_requested' AND receipt->>'nextPhase' IN ('host_requested','host_acknowledged'))),
   false);
$function$
$object$;
 ELSIF encode(sha256(convert_to(actual,'UTF8')),'hex') NOT IN ('0cda5ba465b509f77a8c2ece5692b9f222fcc4c9160a25b9b031f2380b7cdd37') THEN
  RAISE EXCEPTION 'Unqualified schema drift: valid_erasure_provision_ack';
 END IF;
END
$object_guard$;

REVOKE ALL ON FUNCTION public."valid_erasure_provision_ack"(jsonb, jsonb) FROM PUBLIC;

DO $pod_414$
BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN GRANT EXECUTE ON FUNCTION public."valid_erasure_provision_ack"(jsonb, jsonb) TO service_role; END IF;
END
$pod_414$;

DO $object_guard$
DECLARE actual text;
BEGIN
 SELECT definition INTO actual FROM (SELECT pg_get_functiondef(p.oid) definition FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='valid_erasure_repository_grant_append' AND pg_get_function_identity_arguments(p.oid)='old_r jsonb, new_r jsonb') observed;
 IF actual IS NULL THEN
  EXECUTE $object$CREATE OR REPLACE FUNCTION public.valid_erasure_repository_grant_append(old_r jsonb, new_r jsonb)
 RETURNS boolean
 LANGUAGE plpgsql
 IMMUTABLE
 SET search_path TO 'public'
AS $function$
DECLARE old_s jsonb; new_s jsonb; stage text;
BEGIN
 old_s:=coalesce(old_r->'repositoryGrantErasure','{}'::jsonb); new_s:=new_r->'repositoryGrantErasure';
 IF new_r - 'repositoryGrantErasure' IS DISTINCT FROM old_r - 'repositoryGrantErasure' OR jsonb_typeof(new_s) IS DISTINCT FROM 'object' THEN RETURN false; END IF;
 FOREACH stage IN ARRAY ARRAY['admission','acknowledgement','deletion'] LOOP
  IF NOT (old_s ? stage) AND new_s - stage=old_s AND public.valid_erasure_repository_grant_receipt(old_r,stage,new_s->stage) IS TRUE THEN RETURN true; END IF;
 END LOOP;
 RETURN false;
END;
$function$
$object$;
 ELSIF encode(sha256(convert_to(actual,'UTF8')),'hex') NOT IN ('caa3fb681de4916faa7d848f3bcd6ed2c3e98a1aee55ba2e5e5f074e6b29d010') THEN
  RAISE EXCEPTION 'Unqualified schema drift: valid_erasure_repository_grant_append';
 END IF;
END
$object_guard$;

REVOKE ALL ON FUNCTION public."valid_erasure_repository_grant_append"(jsonb, jsonb) FROM PUBLIC;

DO $pod_414$
BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN GRANT EXECUTE ON FUNCTION public."valid_erasure_repository_grant_append"(jsonb, jsonb) TO service_role; END IF;
END
$pod_414$;

DO $object_guard$
DECLARE actual text;
BEGIN
 SELECT definition INTO actual FROM (SELECT pg_get_functiondef(p.oid) definition FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='valid_erasure_repository_grant_receipt' AND pg_get_function_identity_arguments(p.oid)='r jsonb, stage text, receipt jsonb') observed;
 IF actual IS NULL THEN
  EXECUTE $object$CREATE OR REPLACE FUNCTION public.valid_erasure_repository_grant_receipt(r jsonb, stage text, receipt jsonb)
 RETURNS boolean
 LANGUAGE plpgsql
 IMMUTABLE
 SET search_path TO 'public'
AS $function$
DECLARE binding jsonb; identity jsonb; admitted jsonb;
BEGIN
 IF stage IS NULL OR stage NOT IN ('admission','acknowledgement','deletion') OR jsonb_typeof(receipt) IS DISTINCT FROM 'object'
 OR public.valid_erasure_grant_release(r,r->'grantRelease') IS DISTINCT FROM true THEN RETURN false; END IF;
 IF public.erasure_runtime_grants_complete(r) IS DISTINCT FROM true THEN RETURN false; END IF;
 identity:=receipt->'repositoryIdentity'; binding:=receipt->'bindingObservation';
 IF jsonb_typeof(identity) IS DISTINCT FROM 'object'
 OR identity - ARRAY['name','format','createTime']<>'{}'::jsonb
 OR identity->>'name' IS DISTINCT FROM 'projects/'||(r->'grantRelease'->>'project')||'/locations/'||(r->'registrySnapshot'->>'user_cloud_region')||'/repositories/one-pod'
 OR identity->>'format' IS DISTINCT FROM 'DOCKER'
 OR (identity->>'createTime' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,9})?(Z|[+-][0-9]{2}:[0-9]{2})$') IS DISTINCT FROM true
 OR (SELECT count(*) FROM jsonb_array_elements(r->'substrateInventory'->'plannedResources') p WHERE p->>'type'='artifact_repository' AND p->>'id'='one-pod')<>1
 OR (SELECT count(*) FROM jsonb_array_elements(r->'substrateInventory'->'resourceObservations') o WHERE o=jsonb_build_object('type','artifact_repository','id','one-pod','disposition','created','identity',identity))<>1 THEN RETURN false; END IF;
 IF receipt - ARRAY['ownerId','attemptId','repositoryIdentity','bindingObservation','status']<>'{}'::jsonb
 OR receipt->>'ownerId' IS DISTINCT FROM r->>'ownerId' OR receipt->>'attemptId' IS DISTINCT FROM r->>'attemptId'
 OR receipt->'repositoryIdentity' IS DISTINCT FROM identity OR jsonb_typeof(binding) IS DISTINCT FROM 'object'
 OR binding - ARRAY['step','policyResource','role','member','disposition','beforeEtag','afterEtag']<>'{}'::jsonb
 OR binding->>'step' IS DISTINCT FROM 'artifact_repo_grant_copy_writer' OR binding->>'role' IS DISTINCT FROM 'roles/artifactregistry.writer'
 OR binding->>'disposition' IS DISTINCT FROM 'added'
 OR (binding->>'member' ~ '^serviceAccount:[a-zA-Z0-9._-]+@[a-zA-Z0-9.-]+\.gserviceaccount\.com$') IS DISTINCT FROM true
 OR binding->>'policyResource' IS DISTINCT FROM 'https://artifactregistry.googleapis.com/v1/'||(identity->>'name')||':getIamPolicy'
 OR coalesce(length(binding->>'beforeEtag'),0) NOT BETWEEN 1 AND 512 OR coalesce(length(binding->>'afterEtag'),0) NOT BETWEEN 1 AND 512
 OR (SELECT count(*) FROM jsonb_array_elements(r->'substrateInventory'->'bindingObservations') b WHERE b=binding)<>1 THEN RETURN false; END IF;
 IF stage='admission' THEN RETURN receipt->>'status'='admitted'; END IF;
 admitted:=r->'repositoryGrantErasure'->'admission';
 IF public.valid_erasure_repository_grant_receipt(r,'admission',admitted) IS DISTINCT FROM true OR receipt - 'status' IS DISTINCT FROM admitted - 'status' THEN RETURN false; END IF;
 IF stage='acknowledgement' THEN RETURN receipt->>'status'='acknowledged'; END IF;
 -- Fresh observed absence may reconcile a lost write acknowledgement; never fabricate it.
 RETURN receipt->>'status'='observed_absent';
END;
$function$
$object$;
 ELSIF encode(sha256(convert_to(actual,'UTF8')),'hex') NOT IN ('6d57969cb359757416e6918f061ff95c08b15d1cc39499e1fe571d9a97a30715') THEN
  RAISE EXCEPTION 'Unqualified schema drift: valid_erasure_repository_grant_receipt';
 END IF;
END
$object_guard$;

REVOKE ALL ON FUNCTION public."valid_erasure_repository_grant_receipt"(jsonb, text, jsonb) FROM PUBLIC;

DO $pod_414$
BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN GRANT EXECUTE ON FUNCTION public."valid_erasure_repository_grant_receipt"(jsonb, text, jsonb) TO service_role; END IF;
END
$pod_414$;

DO $object_guard$
DECLARE actual text;
BEGIN
 SELECT definition INTO actual FROM (SELECT pg_get_functiondef(p.oid) definition FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='valid_erasure_repository_inventory' AND pg_get_function_identity_arguments(p.oid)='r jsonb, receipt jsonb') observed;
 IF actual IS NULL THEN
  EXECUTE $object$CREATE OR REPLACE FUNCTION public.valid_erasure_repository_inventory(r jsonb, receipt jsonb)
 RETURNS boolean
 LANGUAGE plpgsql
 IMMUTABLE
 SET search_path TO 'public'
AS $function$
DECLARE ident jsonb; image jsonb; prefix text; name_prefix text; admitted jsonb; deleted jsonb;
BEGIN
 -- The immutable predecessor was validated on its original guarded append.
 -- This unresolved observation adds no cleanup authority; do not recursively
 -- revalidate every earlier KMS/mail/account checkpoint for an inventory read.
 admitted:=r->'repositoryGrantErasure'->'admission'; deleted:=r->'repositoryGrantErasure'->'deletion';
 IF jsonb_typeof(admitted) IS DISTINCT FROM 'object' OR jsonb_typeof(deleted) IS DISTINCT FROM 'object'
 OR admitted->>'ownerId' IS DISTINCT FROM r->>'ownerId' OR admitted->>'attemptId' IS DISTINCT FROM r->>'attemptId'
 OR admitted->>'status' IS DISTINCT FROM 'admitted' OR deleted->>'status' IS DISTINCT FROM 'observed_absent'
 OR deleted - 'status' IS DISTINCT FROM admitted - 'status'
 OR jsonb_typeof(r->'substrateInventory'->'resourceObservations') IS DISTINCT FROM 'array'
 OR jsonb_typeof(receipt) IS DISTINCT FROM 'object'$object$ || ' ' || $object$
 OR receipt - ARRAY['ownerId','attemptId','repositoryIdentity','images','paginationComplete','classification']<>'{}'::jsonb
 OR receipt->>'ownerId' IS DISTINCT FROM r->>'ownerId'
 OR receipt->>'attemptId' IS DISTINCT FROM r->>'attemptId'
 OR receipt->'paginationComplete' IS DISTINCT FROM 'true'::jsonb
 OR receipt->>'classification' IS DISTINCT FROM 'unresolved'
 OR receipt->'repositoryIdentity' IS DISTINCT FROM r->'repositoryGrantErasure'->'deletion'->'repositoryIdentity'
 OR jsonb_typeof(receipt->'images') IS DISTINCT FROM 'array' THEN RETURN false; END IF;
 ident:=receipt->'repositoryIdentity';
 IF jsonb_typeof(ident) IS DISTINCT FROM 'object'
 OR ident->>'name' IS DISTINCT FROM 'projects/'||(r->'registrySnapshot'->>'user_cloud_project')||'/locations/'||(r->'registrySnapshot'->>'user_cloud_region')||'/repositories/one-pod'
 OR (SELECT count(*) FROM jsonb_array_elements(r->'substrateInventory'->'resourceObservations') o
     WHERE o=jsonb_build_object('type','artifact_repository','id','one-pod','disposition','created','identity',ident))<>1 THEN RETURN false; END IF;
 prefix:=(r->'registrySnapshot'->>'user_cloud_region')||'-docker.pkg.dev/'||(r->'grantRelease'->>'project')||'/one-pod/';
 name_prefix:=(ident->>'name')||'/dockerImages/';
 IF jsonb_array_length(receipt->'images')>10000 THEN RETURN false; END IF;
 FOR image IN SELECT * FROM jsonb_array_elements(receipt->'images') LOOP
  IF jsonb_typeof(image) IS DISTINCT FROM 'object' OR image - ARRAY['name','uri']<>'{}'::jsonb
  OR jsonb_typeof(image->'name') IS DISTINCT FROM 'string' OR jsonb_typeof(image->'uri') IS DISTINCT FROM 'string'
  OR length(image->>'name') NOT BETWEEN 1 AND 2048 OR length(image->>'uri') NOT BETWEEN 1 AND 2048
  OR left(image->>'name',length(name_prefix)) IS DISTINCT FROM name_prefix
  OR left(image->>'uri',length(prefix)) IS DISTINCT FROM prefix
  OR (substring(image->>'uri' FROM length(prefix)+1) ~ '^[a-z0-9][a-z0-9._/-]*@sha256:[0-9a-f]{64}$') IS DISTINCT FROM true
  OR substring(image->>'name' FROM length(name_prefix)+1) IS DISTINCT FROM substring(image->>'uri' FROM length(prefix)+1) THEN RETURN false; END IF;
 END LOOP;
 RETURN (SELECT count(*)=count(DISTINCT x->>'name') AND count(*)=count(DISTINCT x->>'uri') FROM jsonb_array_elements(receipt->'images') x);
END;
$function$
$object$;
 ELSIF encode(sha256(convert_to(actual,'UTF8')),'hex') NOT IN ('6c2d5f82d86f8a97001f252860d3d770744e43bedd07c5b04eef8cfa99f69d3e') THEN
  RAISE EXCEPTION 'Unqualified schema drift: valid_erasure_repository_inventory';
 END IF;
END
$object_guard$;

REVOKE ALL ON FUNCTION public."valid_erasure_repository_inventory"(jsonb, jsonb) FROM PUBLIC;

DO $pod_414$
BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN GRANT EXECUTE ON FUNCTION public."valid_erasure_repository_inventory"(jsonb, jsonb) TO service_role; END IF;
END
$pod_414$;

DO $object_guard$
DECLARE actual text;
BEGIN
 SELECT definition INTO actual FROM (SELECT pg_get_functiondef(p.oid) definition FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='valid_erasure_repository_retention' AND pg_get_function_identity_arguments(p.oid)='r jsonb, receipt jsonb') observed;
 IF actual IS NULL THEN
  EXECUTE $object$CREATE OR REPLACE FUNCTION public.valid_erasure_repository_retention(r jsonb, receipt jsonb)
 RETURNS boolean
 LANGUAGE plpgsql
 IMMUTABLE
 SET search_path TO 'public'
AS $function$
BEGIN
 -- Inventory and writer-grant deletion were validated on immutable append.
 -- This settles repository retention, not owner-state erasure or account deletion.
 RETURN public.valid_erasure_repository_inventory(r,r->'repositoryInventory') IS TRUE
 AND jsonb_typeof(receipt)='object'
 AND receipt - ARRAY['ownerId','attemptId','repositoryIdentity','disposition','reason']='{}'::jsonb
 AND receipt->>'ownerId'=r->>'ownerId'
 AND receipt->>'attemptId'=r->>'attemptId'
 AND receipt->'repositoryIdentity'=r->'repositoryInventory'->'repositoryIdentity'
 AND receipt->>'disposition'='retained_shared'
 AND receipt->>'reason'='application_distribution_storage';
END;
$function$
$object$;
 ELSIF encode(sha256(convert_to(actual,'UTF8')),'hex') NOT IN ('2e9a07d58915f3a520b7f888733ccbda370321df26bd50f29b942a17c956bce9') THEN
  RAISE EXCEPTION 'Unqualified schema drift: valid_erasure_repository_retention';
 END IF;
END
$object_guard$;

REVOKE ALL ON FUNCTION public."valid_erasure_repository_retention"(jsonb, jsonb) FROM PUBLIC;

DO $pod_414$
BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN GRANT EXECUTE ON FUNCTION public."valid_erasure_repository_retention"(jsonb, jsonb) TO service_role; END IF;
END
$pod_414$;

DO $object_guard$
DECLARE actual text;
BEGIN
 SELECT definition INTO actual FROM (SELECT pg_get_functiondef(p.oid) definition FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='valid_erasure_runtime_grant_append' AND pg_get_function_identity_arguments(p.oid)='old_r jsonb, new_r jsonb') observed;
 IF actual IS NULL THEN
  EXECUTE $object$CREATE OR REPLACE FUNCTION public.valid_erasure_runtime_grant_append(old_r jsonb, new_r jsonb)
 RETURNS boolean
 LANGUAGE plpgsql
 IMMUTABLE
 SET search_path TO 'public'
AS $function$
DECLARE old_s jsonb; new_s jsonb; stage text; slot text; previous jsonb; incoming jsonb;
BEGIN
 old_s:=coalesce(old_r->'runtimeGrantErasure','{}'::jsonb); new_s:=new_r->'runtimeGrantErasure';
 IF new_r - 'runtimeGrantErasure' IS DISTINCT FROM old_r - 'runtimeGrantErasure' OR jsonb_typeof(new_s) IS DISTINCT FROM 'object' THEN RETURN false; END IF;
 FOREACH slot IN ARRAY ARRAY['vertex','quota'] LOOP
  previous:=CASE WHEN slot='quota' THEN coalesce(old_s->'quota','{}'::jsonb) ELSE old_s END;
  incoming:=CASE WHEN slot='quota' THEN new_s->'quota' ELSE new_s END;
  IF slot='quota' AND new_s-'quota' IS DISTINCT FROM old_s-'quota' THEN CONTINUE; END IF;
  FOREACH stage IN ARRAY ARRAY['admission','acknowledgement','deletion'] LOOP
   IF NOT (previous ? stage) AND incoming-stage=previous
    AND (incoming->stage->'bindingObservation'->>'role'='roles/serviceusage.serviceUsageConsumer') IS NOT DISTINCT FROM (slot='quota')
    AND public.valid_erasure_runtime_grant_receipt(old_r,stage,incoming->stage) IS TRUE THEN RETURN true; END IF;
  END LOOP;
 END LOOP;
 RETURN false;
END;
$function$
$object$;
 ELSIF encode(sha256(convert_to(actual,'UTF8')),'hex') NOT IN ('8549f1589ab6c2a4e0c68fedf4995e01046ee0fe170adebdefa291663a0e7108') THEN
  RAISE EXCEPTION 'Unqualified schema drift: valid_erasure_runtime_grant_append';
 END IF;
END
$object_guard$;

REVOKE ALL ON FUNCTION public."valid_erasure_runtime_grant_append"(jsonb, jsonb) FROM PUBLIC;

DO $pod_414$
BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN GRANT EXECUTE ON FUNCTION public."valid_erasure_runtime_grant_append"(jsonb, jsonb) TO service_role; END IF;
END
$pod_414$;

DO $object_guard$
DECLARE actual text;
BEGIN
 SELECT definition INTO actual FROM (SELECT pg_get_functiondef(p.oid) definition FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='valid_erasure_runtime_grant_receipt' AND pg_get_function_identity_arguments(p.oid)='r jsonb, stage text, receipt jsonb') observed;
 IF actual IS NULL THEN
  EXECUTE $object$CREATE OR REPLACE FUNCTION public.valid_erasure_runtime_grant_receipt(r jsonb, stage text, receipt jsonb)
 RETURNS boolean
 LANGUAGE plpgsql
 IMMUTABLE
 SET search_path TO 'public'
AS $function$
DECLARE binding jsonb; identity jsonb; admitted jsonb; quota boolean; journal jsonb;
BEGIN
 IF stage IS NULL OR stage NOT IN ('admission','acknowledgement','deletion') OR jsonb_typeof(receipt) IS DISTINCT FROM 'object'
 OR public.valid_erasure_grant_release(r,r->'grantRelease') IS DISTINCT FROM true THEN RETURN false; END IF;
 identity:=r->'writerDisabled'->'runtimeIdentity'; binding:=receipt->'bindingObservation';
 quota:=binding->>'role'='roles/serviceusage.serviceUsageConsumer' AND binding->>'step'='iam_pod_sa_quota';
 journal:=CASE WHEN quota THEN r->'runtimeGrantErasure'->'quota' ELSE r->'runtimeGrantErasure' END;
 IF receipt - ARRAY['ownerId','attemptId','runtimeIdentity','bindingObservation','status']<>'{}'::jsonb
 OR receipt->>'ownerId' IS DISTINCT FROM r->>'ownerId' OR receipt->>'attemptId' IS DISTINCT FROM r->>'attemptId'
 OR receipt->'runtimeIdentity' IS DISTINCT FROM identity OR jsonb_typeof(binding) IS DISTINCT FROM 'object'
 OR binding - ARRAY['step','policyResource','role','member','disposition','beforeEtag','afterEtag']<>'{}'::jsonb
 OR ((binding->>'step'='iam_pod_sa_vertex' AND binding->>'role'='roles/aiplatform.user') OR quota) IS DISTINCT FROM true
 OR binding->>'disposition' IS DISTINCT FROM 'added'
 OR binding->>'member' IS DISTINCT FROM 'serviceAccount:'||(identity->>'email')
 OR binding->>'policyResource' IS DISTINCT FROM 'https://cloudresourcemanager.googleapis.com/v1/projects/'||(r->'grantRelease'->>'project')||':getIamPolicy'
 OR coalesce(length(binding->>'beforeEtag'),0) NOT BETWEEN 1 AND 512 OR coalesce(length(binding->>'afterEtag'),0) NOT BETWEEN 1 AND 512
 OR (SELECT count(*) FROM jsonb_array_elements(r->'substrateInventory'->'bindingObservations') b WHERE b=binding)<>1 THEN RETURN false; END IF;
 IF stage='admission' THEN RETURN receipt->>'status'='admitted'; END IF;
 admitted:=journal->'admission';
 IF public.valid_erasure_runtime_grant_receipt(r,'admission',admitted) IS DISTINCT FROM true OR receipt - 'status' IS DISTINCT FROM admitted - 'status' THEN RETURN false; END IF;
 IF stage='acknowledgement' THEN RETURN receipt->>'status'='acknowledged'; END IF;
 -- Fresh observed absence may reconcile a lost write acknowledgement; never fabricate it.
 RETURN receipt->>'status'='observed_absent';
END;
$function$
$object$;
 ELSIF encode(sha256(convert_to(actual,'UTF8')),'hex') NOT IN ('b1dbfe224d414413b13f51186bfea0cf54bf609be6840a27b8b692582effc9ae') THEN
  RAISE EXCEPTION 'Unqualified schema drift: valid_erasure_runtime_grant_receipt';
 END IF;
END
$object_guard$;

REVOKE ALL ON FUNCTION public."valid_erasure_runtime_grant_receipt"(jsonb, text, jsonb) FROM PUBLIC;

DO $pod_414$
BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN GRANT EXECUTE ON FUNCTION public."valid_erasure_runtime_grant_receipt"(jsonb, text, jsonb) TO service_role; END IF;
END
$pod_414$;

DO $object_guard$
DECLARE actual text;
BEGIN
 SELECT definition INTO actual FROM (SELECT pg_get_functiondef(p.oid) definition FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='valid_erasure_secret_append' AND pg_get_function_identity_arguments(p.oid)='old_r jsonb, new_r jsonb') observed;
 IF actual IS NULL THEN
  EXECUTE $object$CREATE OR REPLACE FUNCTION public.valid_erasure_secret_append(old_r jsonb, new_r jsonb)
 RETURNS boolean
 LANGUAGE plpgsql
 IMMUTABLE
 SET search_path TO 'public'
AS $function$
DECLARE old_s jsonb; new_s jsonb; stage text;
BEGIN
 old_s:=coalesce(old_r->'secretErasure','{}'::jsonb); new_s:=new_r->'secretErasure';
 IF new_r - 'secretErasure' IS DISTINCT FROM old_r - 'secretErasure' OR jsonb_typeof(new_s) IS DISTINCT FROM 'object' THEN RETURN false; END IF;
 FOREACH stage IN ARRAY ARRAY['admission','acknowledgement','deletion'] LOOP
  IF NOT (old_s ? stage) AND new_s - stage=old_s AND public.valid_erasure_secret_receipt(old_r,stage,new_s->stage) IS TRUE THEN RETURN true; END IF;
 END LOOP;
 RETURN false;
END;
$function$
$object$;
 ELSIF encode(sha256(convert_to(actual,'UTF8')),'hex') NOT IN ('30700d3b373f04d9263fba33c510e941e631416b3b7ce3e0c7afc2132e07011d') THEN
  RAISE EXCEPTION 'Unqualified schema drift: valid_erasure_secret_append';
 END IF;
END
$object_guard$;

REVOKE ALL ON FUNCTION public."valid_erasure_secret_append"(jsonb, jsonb) FROM PUBLIC;

DO $pod_414$
BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN GRANT EXECUTE ON FUNCTION public."valid_erasure_secret_append"(jsonb, jsonb) TO service_role; END IF;
END
$pod_414$;

DO $object_guard$
DECLARE actual text;
BEGIN
 SELECT definition INTO actual FROM (SELECT pg_get_functiondef(p.oid) definition FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='valid_erasure_secret_receipt' AND pg_get_function_identity_arguments(p.oid)='r jsonb, stage text, receipt jsonb') observed;
 IF actual IS NULL THEN
  EXECUTE $object$CREATE OR REPLACE FUNCTION public.valid_erasure_secret_receipt(r jsonb, stage text, receipt jsonb)
 RETURNS boolean
 LANGUAGE plpgsql
 IMMUTABLE
 SET search_path TO 'public'
AS $function$
DECLARE obs jsonb; ident jsonb; inv jsonb; admitted jsonb; project text;
BEGIN
 IF stage IS NULL OR stage NOT IN ('admission','acknowledgement','deletion')
 OR jsonb_typeof(receipt) IS DISTINCT FROM 'object'
 OR public.valid_erasure_kms_receipt(r,'completion',r->'kmsErasure'->'completion') IS DISTINCT FROM true THEN RETURN false; END IF;
 obs:=receipt->'resourceObservation'; ident:=obs->'identity'; inv:=r->'substrateInventory'; project:=r->'registrySnapshot'->>'user_cloud_project';
 IF receipt - ARRAY['ownerId','attemptId','resourceObservation','etag','status'] <> '{}'::jsonb
 OR receipt->>'ownerId' IS DISTINCT FROM r->>'ownerId' OR receipt->>'attemptId' IS DISTINCT FROM r->>'attemptId'
 OR jsonb_typeof(receipt->'etag') IS DISTINCT FROM 'string' OR length(btrim(receipt->>'etag')) NOT BETWEEN 1 AND 512
 OR jsonb_typeof(obs) IS DISTINCT FROM 'object' OR obs - ARRAY['type','id','disposition','identity'] <> '{}'::jsonb
 OR obs->>'type' IS DISTINCT FROM 'secret' OR obs->>'disposition' IS DISTINCT FROM 'created'
 OR obs->>'id' IS NULL OR obs->>'id' !~ '^[A-Za-z0-9_-]{1,255}$'
 OR jsonb_typeof(ident) IS DISTINCT FROM 'object' OR ident - ARRAY['name','projectId','projectNumber','createTime'] <> '{}'::jsonb
 OR project IS NULL OR ident->>'projectId' IS DISTINCT FROM project
 OR jsonb_typeof(ident->'createTime') IS DISTINCT FROM 'string' OR length(ident->>'createTime') NOT BETWEEN 1 AND 64
 OR (SELECT count(*) FROM jsonb_array_elements(inv->'plannedResources') x WHERE x->>'type'='secret') <> 1
 OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(inv->'plannedResources') x WHERE x->>'type'='secret' AND x->>'id'=obs->>'id')
 OR (SELECT count(*) FROM jsonb_array_elements(inv->'resourceObservations') x WHERE x=obs) <> 1 THEN RETURN false; END IF;
 IF ident ? 'projectNumber' AND (jsonb_typeof(ident->'projectNumber') IS DISTINCT FROM 'string' OR ident->>'projectNumber' !~ '^[1-9][0-9]{0,19}$') THEN RETURN false; END IF;
 IF ident->>'name' IS DISTINCT FROM 'projects/' || project || '/secrets/' || (obs->>'id')
 AND (NOT (ident ? 'projectNumber') OR ident->>'name' IS DISTINCT FROM 'projects/' || (ident->>'projectNumber') || '/secrets/' || (obs->>'id')) THEN RETURN false; END IF;
 IF stage='admission' THEN RETURN receipt->>'status'='admitted'; END IF;
 admitted:=r->'secretErasure'->'admission';
 IF jsonb_typeof(admitted) IS DISTINCT FROM 'object' THEN RETURN false; END IF;
 IF admitted->>'status' IS DISTINCT FROM 'admitted' OR receipt - 'status' IS DISTINCT FROM admitted - 'status' THEN RETURN false; END IF;
 IF stage='acknowledgement' THEN RETURN receipt->>'status'='acknowledged'; END IF;
 admitted:=r->'secretErasure'->'acknowledgement';
 IF jsonb_typeof(admitted) IS DISTINCT FROM 'object' THEN RETURN false; END IF;
 RETURN receipt->>'status'='absent' AND admitted->>'status' IS NOT DISTINCT FROM 'acknowledged'
   AND receipt - 'status' IS NOT DISTINCT FROM admitted - 'status';
END;
$function$
$object$;
 ELSIF encode(sha256(convert_to(actual,'UTF8')),'hex') NOT IN ('9fd18377bf2d060aac9d7236c708dacefe2b674b19a381b0778ddac15be0672c') THEN
  RAISE EXCEPTION 'Unqualified schema drift: valid_erasure_secret_receipt';
 END IF;
END
$object_guard$;

REVOKE ALL ON FUNCTION public."valid_erasure_secret_receipt"(jsonb, text, jsonb) FROM PUBLIC;

DO $pod_414$
BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN GRANT EXECUTE ON FUNCTION public."valid_erasure_secret_receipt"(jsonb, text, jsonb) TO service_role; END IF;
END
$pod_414$;

DO $object_guard$
DECLARE actual text;
BEGIN
 SELECT definition INTO actual FROM (SELECT pg_get_functiondef(p.oid) definition FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='valid_erasure_substrate_inventory' AND pg_get_function_identity_arguments(p.oid)='reservation jsonb, inventory jsonb') observed;
 IF actual IS NULL THEN
  EXECUTE $object$CREATE OR REPLACE FUNCTION public.valid_erasure_substrate_inventory(reservation jsonb, inventory jsonb)
 RETURNS boolean
 LANGUAGE plpgsql
 IMMUTABLE
 SET search_path TO 'public'
AS $function$
BEGIN
 -- 956: do not freeze cleanup inventory while a notification mutation is in flight.
 IF reservation->'registrySnapshot'->'backend_metadata'->'notificationCheckpoint'->>'phase'='intent'
    AND NOT (reservation ? 'lateNotificationObservation') THEN RETURN false; END IF;
 IF jsonb_typeof(inventory) IS DISTINCT FROM 'object'
    OR inventory IS DISTINCT FROM public.effective_erasure_substrate_inventory(reservation)
    OR inventory->>'version' IS DISTINCT FROM 'byoc.substrate.receipt.v1'
    OR jsonb_typeof(inventory->'plannedResources') IS DISTINCT FROM 'array' THEN RETURN false; END IF;
 IF jsonb_array_length(inventory->'plannedResources')=0 THEN RETURN false; END IF;
 RETURN coalesce(public.valid_erasure_compute_receipt(reservation,'computeDeletion',reservation->'computeDeletion'),false);
END;
$function$
$object$;
 ELSIF encode(sha256(convert_to(actual,'UTF8')),'hex') NOT IN ('9f42b37fa525127a5d18761ab6efbac6b00230627e4901aeac4d2fe467d85205') THEN
  RAISE EXCEPTION 'Unqualified schema drift: valid_erasure_substrate_inventory';
 END IF;
END
$object_guard$;

REVOKE ALL ON FUNCTION public."valid_erasure_substrate_inventory"(jsonb, jsonb) FROM PUBLIC;

DO $pod_414$
BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN GRANT EXECUTE ON FUNCTION public."valid_erasure_substrate_inventory"(jsonb, jsonb) TO service_role; END IF;
END
$pod_414$;

DO $object_guard$
DECLARE actual text;
BEGIN
 SELECT definition INTO actual FROM (SELECT pg_get_functiondef(p.oid) definition FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='valid_erasure_upgrade_ack' AND pg_get_function_identity_arguments(p.oid)='reservation jsonb, receipt jsonb') observed;
 IF actual IS NULL THEN
  EXECUTE $object$CREATE OR REPLACE FUNCTION public.valid_erasure_upgrade_ack(reservation jsonb, receipt jsonb)
 RETURNS boolean
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public'
AS $function$
  SELECT coalesce(
    jsonb_typeof(receipt) = 'object' AND octet_length(receipt::text) <= 16384
    AND receipt->>'version' = '1'
    AND jsonb_typeof(receipt->'generation') = 'number'
    AND receipt->>'generation' ~ '^[1-9][0-9]*$'
    AND receipt->>'attemptId' = encode(sha256(convert_to(
        reservation->'registrySnapshot'->'backend_metadata'->>'upgradeLease', 'UTF8')), 'hex')
    AND length(receipt->>'serviceUid') > 0 AND length(receipt->>'service') > 0
    AND receipt->>'serviceUid' = reservation->'registrySnapshot'->'backend_metadata'->>'serviceUid'
    AND receipt->>'service' = coalesce(
        reservation->'registrySnapshot'->'backend_metadata'->>'service',
        reservation->'registrySnapshot'->>'external_agent_id')
    AND length(receipt->>'image') > 0 AND length(receipt->>'targetImage') > 0
    AND right(reservation->'registrySnapshot'->'backend_metadata'->>'upgradeLease',
        length(receipt->>'targetImage') + 1) = '|' || (receipt->>'targetImage'),
    false
  );
$function$
$object$;
 ELSIF encode(sha256(convert_to(actual,'UTF8')),'hex') NOT IN ('8367cdaa9aa6249842e071d39c0e8a0b0da6d4a575a1f86faa306622845cd11e') THEN
  RAISE EXCEPTION 'Unqualified schema drift: valid_erasure_upgrade_ack';
 END IF;
END
$object_guard$;

REVOKE ALL ON FUNCTION public."valid_erasure_upgrade_ack"(jsonb, jsonb) FROM PUBLIC;

DO $pod_414$
BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN GRANT EXECUTE ON FUNCTION public."valid_erasure_upgrade_ack"(jsonb, jsonb) TO service_role; END IF;
END
$pod_414$;

DO $object_guard$
DECLARE actual text;
BEGIN
 SELECT definition INTO actual FROM (SELECT pg_get_functiondef(p.oid) definition FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='valid_erasure_writer_append' AND pg_get_function_identity_arguments(p.oid)='before_record jsonb, after_record jsonb') observed;
 IF actual IS NULL THEN
  EXECUTE $object$CREATE OR REPLACE FUNCTION public.valid_erasure_writer_append(before_record jsonb, after_record jsonb)
 RETURNS boolean
 LANGUAGE plpgsql
 IMMUTABLE
 SET search_path TO 'public'
AS $function$
DECLARE stage text;
BEGIN
 FOREACH stage IN ARRAY ARRAY['writerAdmission','writerDisabled'] LOOP
  IF NOT (before_record ? stage) AND after_record ? stage
     AND after_record-stage=before_record
     AND public.valid_erasure_writer_receipt(before_record,stage,after_record->stage) IS TRUE THEN RETURN true; END IF;
 END LOOP;
 RETURN false;
END;
$function$
$object$;
 ELSIF encode(sha256(convert_to(actual,'UTF8')),'hex') NOT IN ('686198522a7f289c955705120c870915116f02b8dd27a37b2b3b4181c1b4efe0') THEN
  RAISE EXCEPTION 'Unqualified schema drift: valid_erasure_writer_append';
 END IF;
END
$object_guard$;

REVOKE ALL ON FUNCTION public."valid_erasure_writer_append"(jsonb, jsonb) FROM PUBLIC;

DO $pod_414$
BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN GRANT EXECUTE ON FUNCTION public."valid_erasure_writer_append"(jsonb, jsonb) TO service_role; END IF;
END
$pod_414$;

DO $object_guard$
DECLARE actual text;
BEGIN
 SELECT definition INTO actual FROM (SELECT pg_get_functiondef(p.oid) definition FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='valid_erasure_writer_receipt' AND pg_get_function_identity_arguments(p.oid)='reservation jsonb, stage text, receipt jsonb') observed;
 IF actual IS NULL THEN
  EXECUTE $object$CREATE OR REPLACE FUNCTION public.valid_erasure_writer_receipt(reservation jsonb, stage text, receipt jsonb)
 RETURNS boolean
 LANGUAGE plpgsql
 IMMUTABLE
 SET search_path TO 'public'
AS $function$
DECLARE snapshot jsonb; inventory jsonb; runtime_identity jsonb; bootstrap_identity jsonb; project text; bootstrap_ref text;
BEGIN
 snapshot := reservation->'registrySnapshot'; inventory := reservation->'substrateInventory';
 IF public.valid_erasure_substrate_inventory(reservation,inventory) IS DISTINCT FROM true
    OR stage NOT IN ('writerAdmission','writerDisabled') OR stage IS NULL
    OR jsonb_typeof(receipt) IS DISTINCT FROM 'object' THEN RETURN false; END IF;
 runtime_identity := receipt->'runtimeIdentity'; bootstrap_identity := receipt->'bootstrapIdentity';
 project := snapshot->>'user_cloud_project';
 bootstrap_ref := regexp_replace(snapshot->>'user_cloud_bootstrap_sa','^serviceAccount:','');
 IF project IS NULL OR project !~ '^[a-z][a-z0-9-]{4,61}[a-z0-9]$'
    OR receipt->>'ownerId' IS DISTINCT FROM reservation->>'ownerId'
    OR receipt->>'attemptId' IS DISTINCT FROM reservation->>'attemptId'
    OR receipt - ARRAY['ownerId','attemptId','runtimeIdentity','bootstrapIdentity','status'] <> '{}'::jsonb
    OR jsonb_typeof(runtime_identity) IS DISTINCT FROM 'object'
    OR jsonb_typeof(bootstrap_identity) IS DISTINCT FROM 'object' THEN RETURN false; END IF;
 IF runtime_identity->>'projectId' IS DISTINCT FROM project
    OR bootstrap_identity->>'projectId' IS DISTINCT FROM project
    OR runtime_identity->>'email' IS DISTINCT FROM snapshot->'backend_metadata'->>'runtime_service_account'
    OR runtime_identity->>'uniqueId' IS NULL OR runtime_identity->>'uniqueId' !~ '^[1-9][0-9]{0,31}$'
    OR bootstrap_identity->>'uniqueId' IS NULL OR bootstrap_identity->>'uniqueId' !~ '^[1-9][0-9]{0,31}$'
    OR runtime_identity->>'uniqueId' = bootstrap_identity->>'uniqueId'
    OR bootstrap_ref IS NULL
    OR bootstrap_ref NOT IN (bootstrap_identity->>'email',bootstrap_identity->>'uniqueId') THEN RETURN false; END IF;
 IF bootstrap_identity - ARRAY['name','email','projectId','uniqueId'] <> '{}'::jsonb
    OR bootstrap_identity->>'email' IS NULL
    OR bootstrap_identity->>'email' NOT LIKE '%@' || project || '.iam.gserviceaccount.com'
    OR bootstrap_identity->>'name' IS NULL
    OR bootstrap_identity->>'name' NOT IN ('projects/' || project || '/serviceAccounts/' || (bootstrap_identity->>'email'),
                                         'projects/' || project || '/serviceAccounts/' || (bootstrap_identity->>'uniqueId')) THEN RETURN false; END IF;
 IF jsonb_typeof(inventory->'resourceObservations') IS DISTINCT FROM 'array' THEN RETURN false; END IF;
 IF (SELECT count(*) FROM jsonb_array_elements(inventory->'resourceObservations') AS r
     WHERE r->>'type'='service_account' AND r->>'disposition'='created'
       AND r->>'id'=runtime_identity->>'email' AND r->'identity'=runtime_identity) <> 1
    OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(inventory->'plannedResources') AS r
                   WHERE r->>'type'='service_account' AND r->>'id'=runtime_identity->>'email') THEN RETURN false; END IF;
 IF stage='writerAdmission' THEN RETURN receipt->>'status'='admitted'; END IF;
 RETURN receipt->>'status'='disabled'
    AND public.valid_erasure_writer_receipt(reservation,'writerAdmission',reservation->'writerAdmission')
    AND receipt - 'status' = (reservation->'writerAdmission') - 'status';
END;
$function$
$object$;
 ELSIF encode(sha256(convert_to(actual,'UTF8')),'hex') NOT IN ('c25e11f3a85b63082a3adcbd08bf93cd6c9f7f439c0db262df42ac49575cd041') THEN
  RAISE EXCEPTION 'Unqualified schema drift: valid_erasure_writer_receipt';
 END IF;
END
$object_guard$;

REVOKE ALL ON FUNCTION public."valid_erasure_writer_receipt"(jsonb, text, jsonb) FROM PUBLIC;

DO $pod_414$
BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN GRANT EXECUTE ON FUNCTION public."valid_erasure_writer_receipt"(jsonb, text, jsonb) TO service_role; END IF;
END
$pod_414$;

DO $object_guard$
DECLARE actual text;
BEGIN
 SELECT definition INTO actual FROM (SELECT pg_get_functiondef(p.oid) definition FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='valid_gcp_browser_update_approval' AND pg_get_function_identity_arguments(p.oid)='agent jsonb, approval jsonb') observed;
 IF actual IS NULL THEN
  EXECUTE $object$CREATE OR REPLACE FUNCTION public.valid_gcp_browser_update_approval(agent jsonb, approval jsonb)
 RETURNS boolean
 LANGUAGE plpgsql
 IMMUTABLE
 SET search_path TO 'public'
AS $function$
DECLARE plan jsonb:=approval->'browserPlan'; expected_release text;
BEGIN
 IF jsonb_typeof(approval) IS DISTINCT FROM 'object' OR jsonb_typeof(plan) IS DISTINCT FROM 'object'
 OR octet_length(approval::text)>65536
 OR approval->'version' IS DISTINCT FROM '2'::jsonb OR approval->>'capability' IS DISTINCT FROM 'browser'
 OR approval->'capabilityPlan' IS NOT NULL OR approval->'capabilityPlanDigest' IS NOT NULL
 OR agent->>'deployment_target' IS DISTINCT FROM 'user_gcp' OR agent->>'status' IS DISTINCT FROM 'provisioned'
 OR agent->'backend_metadata' ? 'erasure' OR agent->>'pod_key_id' IS NULL
 OR approval->>'ownerId' IS DISTINCT FROM agent->>'user_id'
 OR approval->>'hushhId' IS DISTINCT FROM agent->>'hushh_id'
 OR approval->>'podIncarnation' IS DISTINCT FROM agent->'backend_metadata'->>'serviceUid'
 OR plan->'version' IS DISTINCT FROM '1'::jsonb OR plan->>'capability' IS DISTINCT FROM 'browser'
 OR plan->>'hostKind' IS DISTINCT FROM 'gcp_cloud_run'
 OR plan->>'ownerId' IS DISTINCT FROM agent->>'user_id'
 OR plan->>'hushhId' IS DISTINCT FROM agent->>'hushh_id'
 OR plan->>'podKeyId' IS DISTINCT FROM agent->>'pod_key_id'
 OR plan->'placementEpoch' IS DISTINCT FROM agent->'placement_epoch'
 OR plan->>'serviceUid' IS DISTINCT FROM agent->'backend_metadata'->>'serviceUid'
 OR plan->>'service' IS DISTINCT FROM agent->>'external_agent_id'
 OR plan->>'project' IS DISTINCT FROM agent->>'user_cloud_project'
 OR plan->>'region' IS DISTINCT FROM agent->>'user_cloud_region'
 OR plan->>'bootstrapAccount' IS DISTINCT FROM agent->>'user_cloud_bootstrap_sa'
 OR plan->>'runtimeAccount' IS DISTINCT FROM agent->'backend_metadata'->>'runtime_service_account'
 OR plan->>'targetImage' IS DISTINCT FROM approval->>'targetImage'
 OR (approval->>'targetImage' ~ '^.+@sha256:[a-f0-9]{64}$') IS NOT TRUE
 OR (approval->>'browserPlanDigest' ~ '^[a-f0-9]{64}$') IS NOT TRUE
 OR (plan->>'templateDigest' ~ '^[a-f0-9]{64}$') IS NOT TRUE
 OR (plan->>'qualificationDigest' ~ '^[a-f0-9]{64}$') IS NOT TRUE
 OR jsonb_typeof(plan->'publicPolicy') IS DISTINCT FROM 'object'
 OR jsonb_typeof(plan->'resourceLimits') IS DISTINCT FROM 'object'
 THEN RETURN false; END IF;
 -- The application independently validates the complete canonical plan digest.
 -- SQL binds that commitment to this current owner/key/placement and operation.
 expected_release:='rel_'||left(encode(sha256(convert_to(concat_ws('|',
  approval->>'hushhId',approval->>'podIncarnation',approval->>'targetImage',
  'browser.v1',approval->>'browserPlanDigest'),'UTF8')),'hex'),32);
 RETURN approval->>'releaseId'=expected_release;
END;
$function$
$object$;
 ELSIF encode(sha256(convert_to(actual,'UTF8')),'hex') NOT IN ('126ca4418734df83337fd626fcd20445d7f7674352623f5fab9ee33215bfc630') THEN
  RAISE EXCEPTION 'Unqualified schema drift: valid_gcp_browser_update_approval';
 END IF;
END
$object_guard$;

REVOKE ALL ON FUNCTION public."valid_gcp_browser_update_approval"(jsonb, jsonb) FROM PUBLIC;

DO $pod_414$
BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN GRANT EXECUTE ON FUNCTION public."valid_gcp_browser_update_approval"(jsonb, jsonb) TO service_role; END IF;
END
$pod_414$;

DO $object_guard$
DECLARE actual text;
BEGIN
 SELECT definition INTO actual FROM (SELECT pg_get_functiondef(p.oid) definition FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='valid_personal_agent_notification_checkpoint' AND pg_get_function_identity_arguments(p.oid)='snapshot jsonb, checkpoint jsonb, previous jsonb') observed;
 IF actual IS NULL THEN
  EXECUTE $object$CREATE OR REPLACE FUNCTION public.valid_personal_agent_notification_checkpoint(snapshot jsonb, checkpoint jsonb, previous jsonb)
 RETURNS boolean
 LANGUAGE plpgsql
 IMMUTABLE
 SET search_path TO 'public'
AS $function$
DECLARE metadata jsonb:=snapshot->'backend_metadata'; plan jsonb:=checkpoint->'plan';
 reservation jsonb:=metadata->'provisionAttempt'; approval jsonb:=metadata->'upgradeApproval';
 slug text:=left(trim(both '-' from regexp_replace(lower(snapshot->>'hushh_id'),'[^a-z0-9-]+','-','g')),40);
 stem text:='one-mail-'||slug; project text:=snapshot->>'user_cloud_project'; region text:=snapshot->>'user_cloud_region';
 service text:=rtrim(left('one-pod-'||trim(both '-' from regexp_replace(lower(snapshot->>'hushh_id'),'[^a-z0-9-]+','-','g')),63),'-');
 uid text; step text:=checkpoint->>'step'; phase text:=checkpoint->>'phase'; result jsonb; prior jsonb;
 resource jsonb; ident jsonb; binding jsonb; config jsonb; origin text; expected_name text; expected_topic text;
 expected_role text; expected_url text; member_pattern text; expected_env jsonb; pinned_origin text:=rtrim(metadata->>'url','/');
BEGIN
 IF jsonb_typeof(snapshot) IS DISTINCT FROM 'object' OR snapshot->>'deployment_target' IS DISTINCT FROM 'user_gcp'
 OR jsonb_typeof(checkpoint) IS DISTINCT FROM 'object' OR octet_length(checkpoint::text)>65536
 OR checkpoint-ARRAY['version','ownerId','hushhId','kind','attemptId','operationId','project','region','plan','serviceUid','generation','phase','step','completed']<>'{}'::jsonb
 OR checkpoint->'version' IS DISTINCT FROM '1'::jsonb
 OR checkpoint->>'ownerId' IS DISTINCT FROM snapshot->>'user_id' OR checkpoint->>'hushhId' IS DISTINCT FROM snapshot->>'hushh_id'
 OR checkpoint->>'project' IS DISTINCT FROM project OR checkpoint->>'region' IS DISTINCT FROM region
 OR coalesce(project,'') !~ '^[a-z][a-z0-9-]{4,61}[a-z0-9]$' OR coalesce(region,'') !~ '^[a-z0-9-]+$'
 OR jsonb_typeof(plan) IS DISTINCT FROM 'object'
 OR plan-ARRAY['oauthProject','runtimeAccount','bootstrapAccount','service','plannedResources']<>'{}'::jsonb
 OR coalesce(plan->>'oauthProject','') !~ '^[a-z][a-z0-9-]{4,61}[a-z0-9]$'
 OR plan->>'bootstrapAccount' IS DISTINCT FROM snapshot->>'user_cloud_bootstrap_sa'
 OR coalesce(plan->>'bootstrapAccount','') !~ ('^[a-z][a-z0-9-]{4,28}@'||project||'[.]iam[.]gserviceaccount[.]com$')
 OR plan->>'service' IS DISTINCT FROM service
 OR coalesce(plan->>'runtimeAccount','') !~ ('^[a-z][a-z0-9-]{4,28}@'||project||'[.]iam[.]gserviceaccount[.]com$')
 OR jsonb_typeof(checkpoint->'generation') IS DISTINCT FROM 'number' OR coalesce(checkpoint->>'generation','') !~ '^[1-9][0-9]{0,15}$'
 OR coalesce(phase,'') NOT IN ('intent','observed') OR jsonb_typeof(checkpoint->'completed') IS DISTINCT FROM 'array'
 OR jsonb_array_length(checkpoint->'completed')>16
 OR coalesce(step,'') NOT IN ('gmail_notification_prerequisite','oauth_mail_topic','iam_gmail_publisher_on_topic',
 'mail_dead_letter_topic','mail_dead_letter_subscription','mail_subscription','generate_pubsub_service_identity',
 'generate_scheduler_service_identity','iam_pubsub_oidc_on_pod','iam_scheduler_oidc_on_pod',
 'iam_pubsub_dead_letter_publisher','iam_pubsub_source_subscriber','gmail_runtime_configuration',
 'gmail_direct_invoker','mail_subscription_configuration','watch_renew_job')
 THEN RETURN false; END IF;
 IF plan->'plannedResources' IS DISTINCT FROM jsonb_build_array(
  jsonb_build_object('type','pubsub_topic','id',stem||'-dead-letter'),
  jsonb_build_object('type','pubsub_subscription','id',stem||'-direct-sub'),
  jsonb_build_object('type','pubsub_subscription','id',stem||'-dead-letter-sub'),
  jsonb_build_object('type','cloud_scheduler_job','id',stem||'-watch-renew'))
 AND plan->'plannedResources' IS DISTINCT FROM (jsonb_build_array(
  jsonb_build_object('type','pubsub_topic','id',stem||'-dead-letter'),
  jsonb_build_object('type','pubsub_subscription','id',stem||'-direct-sub'),
  jsonb_build_object('type','pubsub_subscription','id',stem||'-dead-letter-sub'),
  jsonb_build_object('type','cloud_scheduler_job','id',stem||'-watch-renew'))||jsonb_build_array(
  jsonb_build_object('type','pubsub_topic','id','projects/'||(plan->>'oauthProject')||'/topics/'||stem))) THEN RETURN false; END IF;
 IF checkpoint->>'kind'='provision' THEN
  IF reservation->>'ownerId' IS DISTINCT FROM snapshot->>'user_id'
  OR reservation->>'attemptId' IS DISTINCT FROM checkpoint->>'attemptId'
  OR checkpoint->>'operationId' IS DISTINCT FROM checkpoint->>'attemptId'
  OR coalesce(reservation->>'phase','') NOT IN ('reserved','substrate','host_requested','host_acknowledged','connecting')
  OR coalesce(snapshot->>'status','') NOT IN ('provisioning','connecting') THEN RETURN false; END IF;
  uid:=reservation->'evidence'->'host_requested'->'creationAcknowledgement'->>'serviceUid';
  IF uid IS NOT NULL AND (reservation->'evidence'->'host_requested'->'creationAcknowledgement'->>'service' IS DISTINCT FROM service
    OR reservation->'evidence'->'host_requested'->'creationAcknowledgement'->>'project' IS DISTINCT FROM project
    OR reservation->'evidence'->'host_requested'->'creationAcknowledgement'->>'region' IS DISTINCT FROM region) THEN RETURN false; END IF;
 ELSE
  IF checkpoint->>'kind' IS DISTINCT FROM 'upgrade' OR snapshot->>'status' IS DISTINCT FROM 'provisioned'
  OR coalesce(metadata->>'upgradeLease','')=''
  OR checkpoint->>'attemptId' IS DISTINCT FROM encode(sha256(convert_to(metadata->>'upgradeLease','UTF8')),'hex')
  OR coalesce(approval->>'operationId','')='' OR checkpoint->>'operationId' IS DISTINCT FROM approval->>'operationId'
  OR snapshot->>'external_agent_id' IS DISTINCT FROM service THEN RETURN false; END IF;
  IF (approval->'version' IS DISTINCT FROM '1'::jsonb AND public.valid_gcp_browser_update_approval(snapshot,approval) IS NOT TRUE) OR approval->>'ownerId' IS DISTINCT FROM snapshot->>'user_id'
   OR approval->>'hushhId' IS DISTINCT FROM snapshot->>'hushh_id' OR approval->>'podIncarnation' IS DISTINCT FROM metadata->>'serviceUid'
   OR coalesce(approval->>'status','') NOT IN ('approved','scheduled','updating')
   OR coalesce(approval->>'targetImage','') !~ '^.+@sha256:[a-f0-9]{64}$' THEN RETURN false; END IF;
  uid:=metadata->>'serviceUid';
 END IF;
 IF metadata->>'serviceUid' IS NOT NULL AND uid IS DISTINCT FROM metadata->>'serviceUid' THEN RETURN false; END IF;
 IF uid IS NOT NULL AND checkpoint->>'serviceUid' IS DISTINCT FROM uid THEN RETURN false; END IF;
 IF step IN ('gmail_runtime_configuration','gmail_direct_invoker','mail_subscription_configuration','watch_renew_job')
 AND (coalesce(uid,'')='' OR checkpoint->>'serviceUid' IS DISTINCT FROM uid) THEN RETURN false; END IF;
 IF uid IS NULL AND checkpoint->'serviceUid' IS DISTINCT FROM 'null'::jsonb THEN RETURN false; END IF;
 IF previous IS NOT NULL THEN
  IF (checkpoint->>'generation')::bigint<>(previous->>'generation')::bigint+1 THEN RETURN false; END IF;
  IF checkpoint->>'attemptId'=previous->>'attemptId' AND checkpoint->>'kind'=previous->>'kind' THEN
   IF checkpoint-ARRAY['generation','phase','step','completed','serviceUid'] IS DISTINCT FROM previous-ARRAY['generation','phase','step','completed','serviceUid'] THEN RETURN false; END IF;
   IF phase='intent' AND (previous->>'phase' IS DISTINCT FROM 'observed' OR checkpoint->'completed' IS DISTINCT FROM previous->'completed') THEN RETURN false; END IF;
   IF phase='observed' AND (previous->>'phase' IS DISTINCT FROM 'intent' OR previous->>'step' IS DISTINCT FROM step) THEN RETURN false; END IF;
   FOR prior IN SELECT value FROM jsonb_array_elements(previous->'completed') LOOP
    IF prior->>'step'<>step OR phase='intent' THEN
     IF NOT checkpoint->'completed' @> jsonb_build_array(prior) THEN RETURN false; END IF;
    END IF;
   END LOOP;
   IF phase='observed' AND (SELECT count(*) FROM jsonb_array_elements(checkpoint->'completed') x WHERE x->>'step'<>step)<>(SELECT count(*) FROM jsonb_array_elements(previous->'completed') x WHERE x->>'step'<>step) THEN RETURN false; END IF;
  ELSIF previous->>'phase' IS DISTINCT FROM 'observed' OR phase IS DISTINCT FROM 'intent' OR checkpoint->'completed' IS DISTINCT FROM '[]'::jsonb THEN RETURN false; END IF;
 ELSIF checkpoint->'generation' IS DISTINCT FROM '1'::jsonb OR phase IS DISTINCT FROM 'intent' OR checkpoint->'completed' IS DISTINCT FROM '[]'::jsonb THEN RETURN false;
 END IF;
 IF phase='observed' AND (SELECT count(*) FROM jsonb_array_elements(checkpoint->'completed') x WHERE x->>'step'=step)<>1 THEN RETURN false; END IF;
 IF (SELECT count(*) FROM jsonb_array_elements(checkpoint->'completed'))<>(SELECT count(DISTINCT x->>'step') FROM jsonb_array_elements(checkpoint->'completed') x) THEN RETURN false; END IF;
 FOR result IN SELECT value FROM jsonb_array_elements(checkpoint->'completed') LOOP
  origin:=NULL;
  IF jsonb_typeof(result) IS DISTINCT FROM 'object'
   OR result-ARRAY['step','status','ok','skipped','capability','resourceObservation','bindingObservations','operatorBindingObservations','configurationObservation']<>'{}'::jsonb
   OR jsonb_typeof(result->'ok') IS DISTINCT FROM 'boolean' OR jsonb_typeof(result->'status') IS DISTINCT FROM 'number' OR coalesce(result->>'status','') !~ '^[0-9]{1,3}$'
   OR (result ? 'capability' AND result->>'capability' IS DISTINCT FROM 'gmail_notifications')
   OR (result ? 'skipped' AND jsonb_typeof(result->'skipped') IS DISTINCT FROM 'boolean') THEN RETURN false; END IF;
  IF result ?| ARRAY['resourceObservation','bindingObservations','operatorBindingObservations','configurationObservation']
   AND (result->'ok' IS DISTINCT FROM 'true'::jsonb OR result->>'status' NOT IN ('200','201') OR result->'skipped'='true'::jsonb) THEN RETURN false; END IF;
  IF result->'ok'='true'::jsonb AND result->>'status' IN ('200','201') THEN
   IF result->>'step' IN ('mail_dead_letter_topic','mail_dead_letter_subscription','mail_subscription') AND NOT(result ? 'resourceObservation') THEN RETURN false; END IF;
   IF result->>'step'='oauth_mail_topic' AND jsonb_array_length(plan->'plannedResources')=5
    AND NOT(result ? 'resourceObservation') THEN RETURN false; END IF;
   IF result->>'step' IN ('gmail_runtime_configuration','gmail_direct_invoker','mail_subscription_configuration') AND NOT(result ? 'configurationObservation') THEN RETURN false; END IF;
   IF result->>'step'='watch_renew_job' AND NOT(result ?| ARRAY['resourceObservation','configurationObservation']) THEN RETURN false; END IF;
  END IF;
  resource:=result->'resourceObservation';
  IF resource IS NOT NULL THEN
   IF resource-ARRAY['type','id','disposition','identity']<>'{}'::jsonb OR resource->>'disposition' IS DISTINCT FROM 'created'
    OR NOT plan->'plannedResources' @> jsonb_build_array(jsonb_build_object('type',resource->>'type','id',resource->>'id')) THEN RETURN false; END IF;
   ident:=resource->'identity';
   CASE result->>'step'
    WHEN 'oauth_mail_topic' THEN expected_name:='projects/'||(plan->>'oauthProject')||'/topics/'||stem;
     IF resource->>'type' IS DISTINCT FROM 'pubsub_topic' OR ident IS DISTINCT FROM jsonb_build_object('name',expected_name) THEN RETURN false; END IF;
    WHEN 'mail_dead_letter_topic' THEN expected_name:='projects/'||project||'/topics/'||stem||'-dead-letter';
     IF resource->>'type' IS DISTINCT FROM 'pubsub_topic' OR ident IS DISTINCT FROM jsonb_build_object('name',expected_name) THEN RETURN false; END IF;
    WHEN 'mail_subscription' THEN expected_name:='projects/'||project||'/subscriptions/'||stem||'-direct-sub'; expected_topic:='projects/'||(plan->>'oauthProject')||'/topics/'||stem;
     IF resource->>'type' IS DISTINCT FROM 'pubsub_subscription' OR ident IS DISTINCT FROM jsonb_build_object('name',expected_name,'topic',expected_topic) THEN RETURN false; END IF;
    WHEN 'mail_dead_letter_subscription' THEN expected_name:='projects/'||project||'/subscriptions/'||stem||'-dead-letter-sub'; expected_topic:='projects/'||project||'/topics/'||stem||'-dead-letter';
     IF resource->>'type' IS DISTINCT FROM 'pubsub_subscription' OR ident IS DISTINCT FROM jsonb_build_object('name',expected_name,'topic',expected_topic) THEN RETURN false; END IF;
    WHEN 'watch_renew_job' THEN expected_name:='projects/'||project||'/locations/'||region||'/jobs/'||stem||'-watch-renew';
     IF resource->>'type' IS DISTINCT FROM 'cloud_scheduler_job' OR ident->>'name' IS DISTINCT FROM expected_name THEN RETURN false; END IF;
    ELSE RETURN false;
   END CASE;
   IF resource->>'id' IS DISTINCT FROM (CASE WHEN result->>'step'='oauth_mail_topic' THEN expected_name ELSE regexp_replace(expected_name,'^.*/','') END) THEN RETURN false; END IF;
  END IF;
  IF result ? 'bindingObservations' AND (jsonb_typeof(result->'bindingObservations') IS DISTINCT FROM 'array' OR jsonb_array_length(result->'bindingObservations')>2) THEN RETURN false; END IF;
  IF result ? 'operatorBindingObservations' AND (jsonb_typeof(result->'operatorBindingObservations') IS DISTINCT FROM 'array' OR jsonb_array_length(result->'operatorBindingObservations')>2) THEN RETURN false; END IF;
  FOR binding IN SELECT value FROM jsonb_array_elements(coalesce(result->'bindingObservations','[]'::jsonb)) LOOP
   IF binding-ARRAY['step','policyResource','role','member','disposition','beforeEtag','afterEtag']<>'{}'::jsonb
    OR binding->>'step' IS DISTINCT FROM result->>'step' OR coalesce(binding->>'disposition','') NOT IN ('added','already_present')
    OR jsonb_typeof(binding->'beforeEtag') IS DISTINCT FROM 'string' OR jsonb_typeof(binding->'afterEtag') IS DISTINCT FROM 'string'
    OR length(coalesce(binding->>'beforeEtag','')) NOT BETWEEN 1 AND 512 OR length(coalesce(binding->>'afterEtag','')) NOT BETWEEN 1 AND 512 THEN RETURN false; END IF;
   CASE result->>'step'
    WHEN 'iam_pubsub_oidc_on_pod' THEN expected_role:='roles/iam.serviceAccountOpenIdTokenCreator'; member_pattern:='^serviceAccount:service-[1-9][0-9]*@gcp-sa-pubsub[.]iam[.]gserviceaccount[.]com$'; expected_url:='https://iam.googleapis.com/v1/projects/'||project||'/serviceAccounts/'||(plan->>'runtimeAccount')||':getIamPolicy';
    WHEN 'iam_scheduler_oidc_on_pod' THEN expected_role:='roles/iam.serviceAccountOpenIdTokenCreator'; member_pattern:='^serviceAccount:service-[1-9][0-9]*@gcp-sa-cloudscheduler[.]iam[.]gserviceaccount[.]com$'; expected_url:='https://iam.googleapis.com/v1/projects/'||project||'/serviceAccounts/'||(plan->>'runtimeAccount')||':getIamPolicy';
    WHEN 'iam_pubsub_dead_letter_publisher' THEN expected_role:='roles/pubsub.publisher'; member_pattern:='^serviceAccount:service-[1-9][0-9]*@gcp-sa-pubsub[.]iam[.]gserviceaccount[.]com$'; expected_url:='https://pubsub.googleapis.com/v1/projects/'||project||'/topics/'||stem||'-dead-letter:getIamPolicy';
    WHEN 'iam_pubsub_source_subscriber' THEN expected_role:='roles/pubsub.subscriber'; member_pattern:='^serviceAccount:service-[1-9][0-9]*@gcp-sa-pubsub[.]iam[.]gserviceaccount[.]com$'; expected_url:='https://pubsub.googleapis.com/v1/projects/'||project||'/subscriptions/'||stem||'-direct-sub:getIamPolicy';
    ELSE RETURN false;
   END CASE;
   IF binding->>'role' IS DISTINCT FROM expected_role OR binding->>'policyResource' IS DISTINCT FROM expected_url OR coalesce(binding->>'member','') !~ member_pattern THEN RETURN false; END IF;
  END LOOP;
  FOR binding IN SELECT value FROM jsonb_array_elements(coalesce(result->'operatorBindingObservations','[]'::jsonb)) LOOP
   IF result->>'step' IS DISTINCT FROM 'iam_gmail_publisher_on_topic'
    OR binding-ARRAY['step','policyResource','role','member','disposition','beforeEtag','afterEtag']<>'{}'::jsonb
    OR binding->>'step' IS DISTINCT FROM result->>'step'
    OR binding->>'policyResource' IS DISTINCT FROM 'https://pubsub.googleapis.com/v1/projects/'||(plan->>'oauthProject')||'/topics/'||stem||':getIamPolicy'
    OR (binding->>'role',binding->>'member') NOT IN (('roles/pubsub.publisher','serviceAccount:gmail-api-push@system.gserviceaccount.com'),('roles/pubsub.subscriber','serviceAccount:'||(plan->>'bootstrapAccount')))
    OR coalesce(binding->>'disposition','') NOT IN ('added','already_present') OR jsonb_typeof(binding->'beforeEtag') IS DISTINCT FROM 'string' OR jsonb_typeof(binding->'afterEtag') IS DISTINCT FROM 'string'
    OR length(coalesce(binding->>'beforeEtag','')) NOT BETWEEN 1 AND 512 OR length(coalesce(binding->>'afterEtag','')) NOT BETWEEN 1 AND 512 THEN RETURN false; END IF;
  END LOOP;
  config:=result->'configurationObservation';
  IF config IS NOT NULL OR result->>'step'='watch_renew_job' AND resource IS NOT NULL THEN
   CASE result->>'step'
    WHEN 'gmail_runtime_configuration' THEN
     expected_env:=config->'runtimeEnv'; origin:=expected_env->>'POD_GMAIL_PUSH_AUDIENCE';
     IF config-ARRAY['service','serviceUid','runtimeEnv']<>'{}'::jsonb OR config->>'service' IS DISTINCT FROM service OR config->>'serviceUid' IS DISTINCT FROM uid
      OR expected_env-ARRAY['POD_GMAIL_TOPIC','POD_GMAIL_PUSH_SUBSCRIPTION','POD_GMAIL_PUSH_SERVICE_ACCOUNT','POD_GMAIL_PUSH_AUDIENCE','POD_GMAIL_CONFIG_GENERATION','HUSSH_POD_TICK_AUDIENCE','HUSSH_POD_TICK_ALLOWED_EMAILS']<>'{}'::jsonb
      OR coalesce(origin,'') !~ '^https://[a-z0-9][a-z0-9.-]+$'
      OR expected_env->>'POD_GMAIL_TOPIC' IS DISTINCT FROM 'projects/'||(plan->>'oauthProject')||'/topics/'||stem
      OR expected_env->>'POD_GMAIL_PUSH_SUBSCRIPTION' IS DISTINCT FROM 'projects/'||project||'/subscriptions/'||stem||'-direct-sub'
      OR expected_env->>'POD_GMAIL_PUSH_SERVICE_ACCOUNT' IS DISTINCT FROM plan->>'runtimeAccount'
      OR expected_env->>'POD_GMAIL_CONFIG_GENERATION' IS DISTINCT FROM encode(sha256(convert_to(
        '{"POD_GMAIL_PUSH_AUDIENCE":'||to_jsonb(origin)::text||',"POD_GMAIL_PUSH_SERVICE_ACCOUNT":'||to_jsonb(plan->>'runtimeAccount')::text||
        ',"POD_GMAIL_PUSH_SUBSCRIPTION":'||to_jsonb('projects/'||project||'/subscriptions/'||stem||'-direct-sub')::text||
        ',"POD_GMAIL_TOPIC":'||to_jsonb('projects/'||(plan->>'oauthProject')||'/topics/'||stem)::text||'}','UTF8')),'hex')
      OR expected_env->>'HUSSH_POD_TICK_AUDIENCE' IS DISTINCT FROM origin
      OR expected_env->>'HUSSH_POD_TICK_ALLOWED_EMAILS' IS DISTINCT FROM plan->>'runtimeAccount' THEN RETURN false; END IF;
    WHEN 'gmail_direct_invoker' THEN
     IF config IS DISTINCT FROM jsonb_build_object('service',service,'serviceUid',uid,'role','roles/run.invoker','member','serviceAccount:'||(plan->>'runtimeAccount')) THEN RETURN false; END IF;
    WHEN 'mail_subscription_configuration' THEN
     origin:=config->'pushConfig'->'oidcToken'->>'audience';
     IF config IS DISTINCT FROM jsonb_build_object('name','projects/'||project||'/subscriptions/'||stem||'-direct-sub','topic','projects/'||(plan->>'oauthProject')||'/topics/'||stem,
      'pushConfig',jsonb_build_object('pushEndpoint',origin||'/api/one/pod/gmail/push','oidcToken',jsonb_build_object('serviceAccountEmail',plan->>'runtimeAccount','audience',origin)),
      'ackDeadlineSeconds',60,'retryPolicy',jsonb_build_object('minimumBackoff','10s','maximumBackoff','600s'),'messageRetentionDuration','604800s','expirationPolicy','{}'::jsonb,
      'deadLetterPolicy',jsonb_build_object('deadLetterTopic','projects/'||project||'/topics/'||stem||'-dead-letter','maxDeliveryAttempts',10)) OR coalesce(origin,'') !~ '^https://[a-z0-9][a-z0-9.-]+$' THEN RETURN false; END IF;
    WHEN 'watch_renew_job' THEN
     config:=coalesce(config,ident); origin:=config->'httpTarget'->'oidcToken'->>'audience';
     IF config IS DISTINCT FROM jsonb_build_object('name','projects/'||project||'/locations/'||region||'/jobs/'||stem||'-watch-renew','schedule','0 4 * * *','timeZone','Etc/UTC',
      'httpTarget',jsonb_build_object('uri',origin||'/api/one/pod/maintenance/tick','httpMethod','POST','oidcToken',jsonb_build_object('audience',origin,'serviceAccountEmail',plan->>'runtimeAccount')))
      OR coalesce(origin,'') !~ '^https://[a-z0-9][a-z0-9.-]+$' THEN RETURN false; END IF;
    ELSE RETURN false;
   END CASE;
   IF origin IS NOT NULL THEN
    IF pinned_origin IS NOT NULL AND origin IS DISTINCT FROM pinned_origin THEN RETURN false; END IF;
    pinned_origin:=origin;
   END IF;
  END IF;
 END LOOP;
 RETURN true;
EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range OR invalid_parameter_value THEN RETURN false;
END;
$function$
$object$;
 ELSIF encode(sha256(convert_to(actual,'UTF8')),'hex') NOT IN ('e303b67c00e3bef54a0a3a2d1ca7138e6a237df539fc8193373c27db56c0313f') THEN
  RAISE EXCEPTION 'Unqualified schema drift: valid_personal_agent_notification_checkpoint';
 END IF;
END
$object_guard$;

REVOKE ALL ON FUNCTION public."valid_personal_agent_notification_checkpoint"(jsonb, jsonb, jsonb) FROM PUBLIC;

DO $pod_414$
BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN GRANT EXECUTE ON FUNCTION public."valid_personal_agent_notification_checkpoint"(jsonb, jsonb, jsonb) TO service_role; END IF;
END
$pod_414$;

DO $object_guard$
DECLARE actual text;
BEGIN
 SELECT definition INTO actual FROM (SELECT pg_get_functiondef(p.oid) definition FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='valid_pod_upgrade_cursor' AND pg_get_function_identity_arguments(p.oid)='cursor_value jsonb') observed;
 IF actual IS NULL THEN
  EXECUTE $object$CREATE OR REPLACE FUNCTION public.valid_pod_upgrade_cursor(cursor_value jsonb)
 RETURNS boolean
 LANGUAGE plpgsql
 IMMUTABLE
AS $function$
BEGIN
 IF jsonb_typeof(cursor_value) IS DISTINCT FROM 'object' THEN RETURN false; END IF;
 RETURN coalesce(cursor_value-ARRAY['seq','sha']='{}'::jsonb
  AND jsonb_typeof(cursor_value->'seq')='number'
  AND cursor_value->>'seq' ~ '^[1-9][0-9]{0,18}$'
  AND jsonb_typeof(cursor_value->'sha')='string'
  AND cursor_value->>'sha' ~ '^[a-f0-9]{64}$',false);
END;
$function$
$object$;
 ELSIF encode(sha256(convert_to(actual,'UTF8')),'hex') NOT IN ('ad5e79175cd4d9754a138e5cab5e462c18e072821fcc41f71ddd00db650c77e4') THEN
  RAISE EXCEPTION 'Unqualified schema drift: valid_pod_upgrade_cursor';
 END IF;
END
$object_guard$;

REVOKE ALL ON FUNCTION public."valid_pod_upgrade_cursor"(jsonb) FROM PUBLIC;

DO $pod_414$
BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN GRANT EXECUTE ON FUNCTION public."valid_pod_upgrade_cursor"(jsonb) TO service_role; END IF;
END
$pod_414$;

DO $object_guard$
DECLARE actual text;
BEGIN
 SELECT definition INTO actual FROM (SELECT pg_get_functiondef(p.oid) definition FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='verify_erasure_account_preflight' AND pg_get_function_identity_arguments(p.oid)='owner_id text, attempt_id text, expected jsonb') observed;
 IF actual IS NULL THEN
  EXECUTE $object$CREATE OR REPLACE FUNCTION public.verify_erasure_account_preflight(owner_id text, attempt_id text, expected jsonb)
 RETURNS boolean
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
 SELECT public.verify_erasure_secret_preflight(owner_id,attempt_id,expected)
 AND public.valid_erasure_secret_receipt(expected,'deletion',expected->'secretErasure'->'deletion') IS TRUE;
$function$
$object$;
 ELSIF encode(sha256(convert_to(actual,'UTF8')),'hex') NOT IN ('19fe4ed482509476fd9703e059a5ef31c79a44dd2a80aed5dbdaad3a6e80d670') THEN
  RAISE EXCEPTION 'Unqualified schema drift: verify_erasure_account_preflight';
 END IF;
END
$object_guard$;

REVOKE ALL ON FUNCTION public."verify_erasure_account_preflight"(text, text, jsonb) FROM PUBLIC;

DO $pod_414$
BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN GRANT EXECUTE ON FUNCTION public."verify_erasure_account_preflight"(text, text, jsonb) TO service_role; END IF;
END
$pod_414$;

DO $object_guard$
DECLARE actual text;
BEGIN
 SELECT definition INTO actual FROM (SELECT pg_get_functiondef(p.oid) definition FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='verify_erasure_bucket_preflight' AND pg_get_function_identity_arguments(p.oid)='owner_id text, attempt_id text, expected jsonb') observed;
 IF actual IS NULL THEN
  EXECUTE $object$CREATE OR REPLACE FUNCTION public.verify_erasure_bucket_preflight(owner_id text, attempt_id text, expected jsonb)
 RETURNS boolean
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
 SELECT EXISTS (SELECT 1 FROM public.personal_agent_registry r
 WHERE r.user_id=owner_id AND r.status='suspended'
 AND r.backend_metadata->'erasure'=expected
 AND expected->>'ownerId'=owner_id AND expected->>'attemptId'=attempt_id
 AND public.valid_erasure_writer_receipt(expected,'writerDisabled',expected->'writerDisabled') IS TRUE
 AND EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid='public.personal_agent_registry'::regclass
    AND tgname='zz_personal_agent_erasure_registry' AND tgenabled IN ('O','A')
    AND tgtype=27 AND tgnargs=0 AND tgqual IS NULL
    AND tgfoid='public.guard_personal_agent_erasure_registry()'::regprocedure));
$function$
$object$;
 ELSIF encode(sha256(convert_to(actual,'UTF8')),'hex') NOT IN ('89a2c80f786a8af2c0ae045667f0772c6f37566abd0224342b6e3e9d0e4c32fa') THEN
  RAISE EXCEPTION 'Unqualified schema drift: verify_erasure_bucket_preflight';
 END IF;
END
$object_guard$;

REVOKE ALL ON FUNCTION public."verify_erasure_bucket_preflight"(text, text, jsonb) FROM PUBLIC;

DO $pod_414$
BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN GRANT EXECUTE ON FUNCTION public."verify_erasure_bucket_preflight"(text, text, jsonb) TO service_role; END IF;
END
$pod_414$;

DO $object_guard$
DECLARE actual text;
BEGIN
 SELECT definition INTO actual FROM (SELECT pg_get_functiondef(p.oid) definition FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='verify_erasure_files_preflight' AND pg_get_function_identity_arguments(p.oid)='owner_id text, attempt_id text, expected jsonb') observed;
 IF actual IS NULL THEN
  EXECUTE $object$CREATE OR REPLACE FUNCTION public.verify_erasure_files_preflight(owner_id text, attempt_id text, expected jsonb)
 RETURNS boolean
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
 SELECT EXISTS (SELECT 1 FROM public.personal_agent_registry r
 WHERE r.user_id=owner_id AND r.status='suspended'
 AND r.backend_metadata->'erasure'=expected
 AND expected->>'ownerId'=owner_id AND expected->>'attemptId'=attempt_id
 AND public.valid_erasure_writer_receipt(expected,'writerDisabled',expected->'writerDisabled') IS TRUE
 AND EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid='public.personal_agent_registry'::regclass
    AND tgname='zz_personal_agent_erasure_registry' AND tgenabled IN ('O','A')
    AND tgtype=27 AND tgnargs=0 AND tgqual IS NULL
    AND tgfoid='public.guard_personal_agent_erasure_registry()'::regprocedure));
$function$
$object$;
 ELSIF encode(sha256(convert_to(actual,'UTF8')),'hex') NOT IN ('b32d6c219359fed29ecb75037eef9bc635754e83e2a16f6d19e4d97e7498bff9') THEN
  RAISE EXCEPTION 'Unqualified schema drift: verify_erasure_files_preflight';
 END IF;
END
$object_guard$;

REVOKE ALL ON FUNCTION public."verify_erasure_files_preflight"(text, text, jsonb) FROM PUBLIC;

DO $pod_414$
BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN GRANT EXECUTE ON FUNCTION public."verify_erasure_files_preflight"(text, text, jsonb) TO service_role; END IF;
END
$pod_414$;

DO $object_guard$
DECLARE actual text;
BEGIN
 SELECT definition INTO actual FROM (SELECT pg_get_functiondef(p.oid) definition FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='verify_erasure_kms_preflight' AND pg_get_function_identity_arguments(p.oid)='owner_id text, attempt_id text, expected jsonb') observed;
 IF actual IS NULL THEN
  EXECUTE $object$CREATE OR REPLACE FUNCTION public.verify_erasure_kms_preflight(owner_id text, attempt_id text, expected jsonb)
 RETURNS boolean
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
 SELECT public.verify_erasure_mail_preflight(owner_id,attempt_id,expected)
 AND public.valid_erasure_bucket_receipt(expected,'bucketDeletion',expected->'bucketDeletion') IS TRUE
 -- 956: exact per-resource closure, including both direct and DLQ subscriptions.
 AND public.erasure_mail_resources_deleted(expected) IS TRUE;
$function$
$object$;
 ELSIF encode(sha256(convert_to(actual,'UTF8')),'hex') NOT IN ('a91634faf17549df0f397ea7326930efde7c209f45962af64271c00fbbda5194') THEN
  RAISE EXCEPTION 'Unqualified schema drift: verify_erasure_kms_preflight';
 END IF;
END
$object_guard$;

REVOKE ALL ON FUNCTION public."verify_erasure_kms_preflight"(text, text, jsonb) FROM PUBLIC;

DO $pod_414$
BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN GRANT EXECUTE ON FUNCTION public."verify_erasure_kms_preflight"(text, text, jsonb) TO service_role; END IF;
END
$pod_414$;

DO $object_guard$
DECLARE actual text;
BEGIN
 SELECT definition INTO actual FROM (SELECT pg_get_functiondef(p.oid) definition FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='verify_erasure_mail_preflight' AND pg_get_function_identity_arguments(p.oid)='owner_id text, attempt_id text, expected jsonb') observed;
 IF actual IS NULL THEN
  EXECUTE $object$CREATE OR REPLACE FUNCTION public.verify_erasure_mail_preflight(owner_id text, attempt_id text, expected jsonb)
 RETURNS boolean
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
 SELECT EXISTS (SELECT 1 FROM public.personal_agent_registry r
 WHERE r.user_id=owner_id AND r.status='suspended'
 AND r.backend_metadata->'erasure'=expected
 AND expected->>'ownerId'=owner_id AND expected->>'attemptId'=attempt_id
 AND public.valid_erasure_writer_receipt(expected,'writerDisabled',expected->'writerDisabled') IS TRUE
 AND EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid='public.personal_agent_registry'::regclass
    AND tgname='zz_personal_agent_erasure_registry' AND tgenabled IN ('O','A')
    AND tgtype=27 AND tgnargs=0 AND tgqual IS NULL
    AND tgfoid='public.guard_personal_agent_erasure_registry()'::regprocedure));
$function$
$object$;
 ELSIF encode(sha256(convert_to(actual,'UTF8')),'hex') NOT IN ('6aeec668582497cdc8bcf55e48f3aae80e1fa68857de3cfaee8436a706d55a34') THEN
  RAISE EXCEPTION 'Unqualified schema drift: verify_erasure_mail_preflight';
 END IF;
END
$object_guard$;

REVOKE ALL ON FUNCTION public."verify_erasure_mail_preflight"(text, text, jsonb) FROM PUBLIC;

DO $pod_414$
BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN GRANT EXECUTE ON FUNCTION public."verify_erasure_mail_preflight"(text, text, jsonb) TO service_role; END IF;
END
$pod_414$;

DO $object_guard$
DECLARE actual text;
BEGIN
 SELECT definition INTO actual FROM (SELECT pg_get_functiondef(p.oid) definition FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='verify_erasure_owner_access_preflight' AND pg_get_function_identity_arguments(p.oid)='owner_id text, attempt_id text, expected jsonb') observed;
 IF actual IS NULL THEN
  EXECUTE $object$CREATE OR REPLACE FUNCTION public.verify_erasure_owner_access_preflight(owner_id text, attempt_id text, expected jsonb)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public'
AS $function$
DECLARE current_row public.personal_agent_registry%ROWTYPE; reservation jsonb;
BEGIN
  SELECT * INTO current_row FROM public.personal_agent_registry WHERE user_id=owner_id;
  IF NOT FOUND OR current_row.status IS DISTINCT FROM 'suspended' THEN RETURN false; END IF;
  reservation := current_row.backend_metadata->'erasure';
  RETURN reservation IS NOT DISTINCT FROM expected
     AND reservation->>'ownerId' IS NOT DISTINCT FROM owner_id
     AND reservation->>'attemptId' IS NOT DISTINCT FROM attempt_id
     AND reservation->>'phase' IS NOT DISTINCT FROM 'reserved'
     AND reservation->'registrySnapshot'->>'deployment_target' IS NOT DISTINCT FROM 'user_azure'
     AND NOT (reservation ? 'agentCryptoErase')
     AND NOT (reservation ? 'ownerAccessErasure')
     AND EXISTS (SELECT 1 FROM pg_trigger
       WHERE tgrelid='public.personal_agent_registry'::regclass
         AND tgname='zz_personal_agent_erasure_registry' AND tgenabled IN ('O','A')
         AND tgtype=27 AND tgnargs=0 AND tgqual IS NULL
         AND tgfoid='public.guard_personal_agent_erasure_registry()'::regprocedure);
END;
$function$
$object$;
 ELSIF encode(sha256(convert_to(actual,'UTF8')),'hex') NOT IN ('50ab7e0c16178f112e8540a5b73a118c854f8dce55da8bcc3e9a6235b033f2fb') THEN
  RAISE EXCEPTION 'Unqualified schema drift: verify_erasure_owner_access_preflight';
 END IF;
END
$object_guard$;

REVOKE ALL ON FUNCTION public."verify_erasure_owner_access_preflight"(text, text, jsonb) FROM PUBLIC;

DO $pod_414$
BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN GRANT EXECUTE ON FUNCTION public."verify_erasure_owner_access_preflight"(text, text, jsonb) TO service_role; END IF;
END
$pod_414$;

DO $object_guard$
DECLARE actual text;
BEGIN
 SELECT definition INTO actual FROM (SELECT pg_get_functiondef(p.oid) definition FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='verify_erasure_secret_preflight' AND pg_get_function_identity_arguments(p.oid)='owner_id text, attempt_id text, expected jsonb') observed;
 IF actual IS NULL THEN
  EXECUTE $object$CREATE OR REPLACE FUNCTION public.verify_erasure_secret_preflight(owner_id text, attempt_id text, expected jsonb)
 RETURNS boolean
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
 SELECT public.verify_erasure_kms_preflight(owner_id,attempt_id,expected)
 AND public.valid_erasure_kms_receipt(expected,'completion',expected->'kmsErasure'->'completion') IS TRUE;
$function$
$object$;
 ELSIF encode(sha256(convert_to(actual,'UTF8')),'hex') NOT IN ('85b0aef24ef19da437adeb336c5836210d0b2214558246e9eaa2cdfc53aeae63') THEN
  RAISE EXCEPTION 'Unqualified schema drift: verify_erasure_secret_preflight';
 END IF;
END
$object_guard$;

REVOKE ALL ON FUNCTION public."verify_erasure_secret_preflight"(text, text, jsonb) FROM PUBLIC;

DO $pod_414$
BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN GRANT EXECUTE ON FUNCTION public."verify_erasure_secret_preflight"(text, text, jsonb) TO service_role; END IF;
END
$pod_414$;

DO $object_guard$
DECLARE actual text;
BEGIN
 SELECT definition INTO actual FROM (SELECT pg_get_indexdef(c.oid) definition FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname='idx_agent_prompt_versions_one_active') observed;
 IF actual IS NULL THEN
  EXECUTE $object$CREATE UNIQUE INDEX idx_agent_prompt_versions_one_active ON public.agent_prompt_versions USING btree (agent_id, channel) WHERE (status = 'active'::text);$object$;
 ELSIF encode(sha256(convert_to(actual,'UTF8')),'hex') NOT IN ('d88c0a2b43667ad4330cc267392b9f9bf362997f5000d39541c3fbef1e0b78ef') THEN
  RAISE EXCEPTION 'Unqualified schema drift: idx_agent_prompt_versions_one_active';
 END IF;
END
$object_guard$;

DO $pod_414$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_index WHERE indexrelid='public.idx_agent_prompt_versions_one_active'::regclass AND indisvalid AND indisready) THEN RAISE EXCEPTION 'Private-agent index is not ready'; END IF;
END
$pod_414$;

DO $object_guard$
DECLARE actual text;
BEGIN
 SELECT definition INTO actual FROM (SELECT pg_get_indexdef(c.oid) definition FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname='idx_agent_prompt_versions_unique') observed;
 IF actual IS NULL THEN
  EXECUTE $object$CREATE UNIQUE INDEX idx_agent_prompt_versions_unique ON public.agent_prompt_versions USING btree (agent_id, channel, version);$object$;
 ELSIF encode(sha256(convert_to(actual,'UTF8')),'hex') NOT IN ('ecd9c27c4889b1bfbee3dea975145117aa6334fafeaba9bf8afac6e141ad35f2') THEN
  RAISE EXCEPTION 'Unqualified schema drift: idx_agent_prompt_versions_unique';
 END IF;
END
$object_guard$;

DO $pod_414$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_index WHERE indexrelid='public.idx_agent_prompt_versions_unique'::regclass AND indisvalid AND indisready) THEN RAISE EXCEPTION 'Private-agent index is not ready'; END IF;
END
$pod_414$;

DO $object_guard$
DECLARE actual text;
BEGIN
 SELECT definition INTO actual FROM (SELECT pg_get_indexdef(c.oid) definition FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname='idx_consent_audit_receipts_audit_event') observed;
 IF actual IS NULL THEN
  EXECUTE $object$CREATE INDEX idx_consent_audit_receipts_audit_event ON public.consent_audit_receipts USING btree (audit_event_id);$object$;
 ELSIF encode(sha256(convert_to(actual,'UTF8')),'hex') NOT IN ('042ce9ffd29e6efce0b1278f8ddc1e0d9f155629493b4d0de386d4fe6454d9be') THEN
  RAISE EXCEPTION 'Unqualified schema drift: idx_consent_audit_receipts_audit_event';
 END IF;
END
$object_guard$;

DO $pod_414$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_index WHERE indexrelid='public.idx_consent_audit_receipts_audit_event'::regclass AND indisvalid AND indisready) THEN RAISE EXCEPTION 'Private-agent index is not ready'; END IF;
END
$pod_414$;

DO $object_guard$
DECLARE actual text;
BEGIN
 SELECT definition INTO actual FROM (SELECT pg_get_indexdef(c.oid) definition FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname='idx_consent_audit_receipts_subject') observed;
 IF actual IS NULL THEN
  EXECUTE $object$CREATE INDEX idx_consent_audit_receipts_subject ON public.consent_audit_receipts USING btree (subject_id, ledger, id);$object$;
 ELSIF encode(sha256(convert_to(actual,'UTF8')),'hex') NOT IN ('d9c1519f6ac0529791dfa55dd00d62de8a6a9b4de6a9bf7bd264bc8bc0debbb5') THEN
  RAISE EXCEPTION 'Unqualified schema drift: idx_consent_audit_receipts_subject';
 END IF;
END
$object_guard$;

DO $pod_414$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_index WHERE indexrelid='public.idx_consent_audit_receipts_subject'::regclass AND indisvalid AND indisready) THEN RAISE EXCEPTION 'Private-agent index is not ready'; END IF;
END
$pod_414$;

DO $object_guard$
DECLARE actual text;
BEGIN
 SELECT definition INTO actual FROM (SELECT pg_get_indexdef(c.oid) definition FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname='idx_personal_agent_tombstones_hushh_id') observed;
 IF actual IS NULL THEN
  EXECUTE $object$CREATE INDEX idx_personal_agent_tombstones_hushh_id ON public.personal_agent_deletion_tombstones USING btree (hushh_id);$object$;
 ELSIF encode(sha256(convert_to(actual,'UTF8')),'hex') NOT IN ('06565221de2944de9000bf096c1a4c83f33e83b066f24f393d60aa6e0ad661a5') THEN
  RAISE EXCEPTION 'Unqualified schema drift: idx_personal_agent_tombstones_hushh_id';
 END IF;
END
$object_guard$;

DO $pod_414$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_index WHERE indexrelid='public.idx_personal_agent_tombstones_hushh_id'::regclass AND indisvalid AND indisready) THEN RAISE EXCEPTION 'Private-agent index is not ready'; END IF;
END
$pod_414$;

DO $object_guard$
DECLARE actual text;
BEGIN
 SELECT definition INTO actual FROM (SELECT pg_get_indexdef(c.oid) definition FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname='idx_personal_agent_tombstones_status') observed;
 IF actual IS NULL THEN
  EXECUTE $object$CREATE INDEX idx_personal_agent_tombstones_status ON public.personal_agent_deletion_tombstones USING btree (status);$object$;
 ELSIF encode(sha256(convert_to(actual,'UTF8')),'hex') NOT IN ('e7b4d81c0a1ce6da7ac94c308189d96db34c5c34b70c4615606280b297681049') THEN
  RAISE EXCEPTION 'Unqualified schema drift: idx_personal_agent_tombstones_status';
 END IF;
END
$object_guard$;

DO $pod_414$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_index WHERE indexrelid='public.idx_personal_agent_tombstones_status'::regclass AND indisvalid AND indisready) THEN RAISE EXCEPTION 'Private-agent index is not ready'; END IF;
END
$pod_414$;

DO $object_guard$
DECLARE actual text;
BEGIN
 SELECT definition INTO actual FROM (SELECT pg_get_indexdef(c.oid) definition FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname='personal_agent_completed_erasure_owner') observed;
 IF actual IS NULL THEN
  EXECUTE $object$CREATE UNIQUE INDEX personal_agent_completed_erasure_owner ON public.personal_agent_deletion_tombstones USING btree (((metadata ->> 'ownerId'::text))) WHERE (status = 'erasure_completed'::text);$object$;
 ELSIF encode(sha256(convert_to(actual,'UTF8')),'hex') NOT IN ('b5f222a8d40dd4146fb75d3d5e6ac9f09088c2d5265a6e1843b21ce33f9cef95') THEN
  RAISE EXCEPTION 'Unqualified schema drift: personal_agent_completed_erasure_owner';
 END IF;
END
$object_guard$;

DO $pod_414$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_index WHERE indexrelid='public.personal_agent_completed_erasure_owner'::regclass AND indisvalid AND indisready) THEN RAISE EXCEPTION 'Private-agent index is not ready'; END IF;
END
$pod_414$;

DO $object_guard$
DECLARE actual text;
BEGIN
 SELECT definition INTO actual FROM (SELECT pg_get_indexdef(c.oid) definition FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname='idx_personal_agent_registry_billing_space_id') observed;
 IF actual IS NULL THEN
  EXECUTE $object$CREATE INDEX idx_personal_agent_registry_billing_space_id ON public.personal_agent_registry USING btree (billing_space_id);$object$;
 ELSIF encode(sha256(convert_to(actual,'UTF8')),'hex') NOT IN ('dac3c6c1bda9e62db460df9d69762e9c63eee3f482b5905be9085214cad70ecd') THEN
  RAISE EXCEPTION 'Unqualified schema drift: idx_personal_agent_registry_billing_space_id';
 END IF;
END
$object_guard$;

DO $pod_414$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_index WHERE indexrelid='public.idx_personal_agent_registry_billing_space_id'::regclass AND indisvalid AND indisready) THEN RAISE EXCEPTION 'Private-agent index is not ready'; END IF;
END
$pod_414$;

DO $object_guard$
DECLARE actual text;
BEGIN
 SELECT definition INTO actual FROM (SELECT pg_get_indexdef(c.oid) definition FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname='idx_personal_agent_registry_health_state') observed;
 IF actual IS NULL THEN
  EXECUTE $object$CREATE INDEX idx_personal_agent_registry_health_state ON public.personal_agent_registry USING btree (health_state) WHERE (health_state <> 'healthy'::text);$object$;
 ELSIF encode(sha256(convert_to(actual,'UTF8')),'hex') NOT IN ('74a8eb4acf693ad2cc8d46288389f0750c2c6e250a0764eb189082518f29eaf8') THEN
  RAISE EXCEPTION 'Unqualified schema drift: idx_personal_agent_registry_health_state';
 END IF;
END
$object_guard$;

DO $pod_414$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_index WHERE indexrelid='public.idx_personal_agent_registry_health_state'::regclass AND indisvalid AND indisready) THEN RAISE EXCEPTION 'Private-agent index is not ready'; END IF;
END
$pod_414$;

DO $object_guard$
DECLARE actual text;
BEGIN
 SELECT definition INTO actual FROM (SELECT pg_get_indexdef(c.oid) definition FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname='idx_personal_agent_registry_heartbeat') observed;
 IF actual IS NULL THEN
  EXECUTE $object$CREATE INDEX idx_personal_agent_registry_heartbeat ON public.personal_agent_registry USING btree (last_heartbeat_at) WHERE (status = ANY (ARRAY['provisioning'::text, 'connecting'::text, 'provisioned'::text]));$object$;
 ELSIF encode(sha256(convert_to(actual,'UTF8')),'hex') NOT IN ('14a4de6a0cbfb0c8b095525ba4a2ab1c6495238c00eb4934d2bdfa0c678f718a') THEN
  RAISE EXCEPTION 'Unqualified schema drift: idx_personal_agent_registry_heartbeat';
 END IF;
END
$object_guard$;

DO $pod_414$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_index WHERE indexrelid='public.idx_personal_agent_registry_heartbeat'::regclass AND indisvalid AND indisready) THEN RAISE EXCEPTION 'Private-agent index is not ready'; END IF;
END
$pod_414$;

DO $object_guard$
DECLARE actual text;
BEGIN
 SELECT definition INTO actual FROM (SELECT pg_get_indexdef(c.oid) definition FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname='idx_personal_agent_registry_hushh_id') observed;
 IF actual IS NULL THEN
  EXECUTE $object$CREATE UNIQUE INDEX idx_personal_agent_registry_hushh_id ON public.personal_agent_registry USING btree (hushh_id);$object$;
 ELSIF encode(sha256(convert_to(actual,'UTF8')),'hex') NOT IN ('8cd7ec30981bfd67af78402dfc706fddfd17dedccaa38543d65ba58a2ddaa358') THEN
  RAISE EXCEPTION 'Unqualified schema drift: idx_personal_agent_registry_hushh_id';
 END IF;
END
$object_guard$;

DO $pod_414$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_index WHERE indexrelid='public.idx_personal_agent_registry_hushh_id'::regclass AND indisvalid AND indisready) THEN RAISE EXCEPTION 'Private-agent index is not ready'; END IF;
END
$pod_414$;

DO $object_guard$
DECLARE actual text;
BEGIN
 SELECT definition INTO actual FROM (SELECT pg_get_indexdef(c.oid) definition FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname='idx_personal_agent_registry_one_owner_per_azure_group') observed;
 IF actual IS NULL THEN
  EXECUTE $object$CREATE UNIQUE INDEX idx_personal_agent_registry_one_owner_per_azure_group ON public.personal_agent_registry USING btree (user_cloud_tenant_id, user_cloud_subscription_id, user_cloud_resource_group) WHERE (deployment_target = 'user_azure'::text);$object$;
 ELSIF encode(sha256(convert_to(actual,'UTF8')),'hex') NOT IN ('4ce5b5636d45002473b25aab0efde168809537bf1301ad1678e12894aa4d234a') THEN
  RAISE EXCEPTION 'Unqualified schema drift: idx_personal_agent_registry_one_owner_per_azure_group';
 END IF;
END
$object_guard$;

DO $pod_414$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_index WHERE indexrelid='public.idx_personal_agent_registry_one_owner_per_azure_group'::regclass AND indisvalid AND indisready) THEN RAISE EXCEPTION 'Private-agent index is not ready'; END IF;
END
$pod_414$;

DO $object_guard$
DECLARE actual text;
BEGIN
 SELECT definition INTO actual FROM (SELECT pg_get_indexdef(c.oid) definition FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname='idx_personal_agent_registry_one_owner_per_cloud') observed;
 IF actual IS NULL THEN
  EXECUTE $object$CREATE UNIQUE INDEX idx_personal_agent_registry_one_owner_per_cloud ON public.personal_agent_registry USING btree (user_cloud_project) WHERE ((deployment_target = 'user_gcp'::text) AND (user_cloud_project IS NOT NULL));$object$;
 ELSIF encode(sha256(convert_to(actual,'UTF8')),'hex') NOT IN ('3939ba16bab3d37c499cc1c5c3d832c5b2b148760270d59bf7842e6ff47cd30e') THEN
  RAISE EXCEPTION 'Unqualified schema drift: idx_personal_agent_registry_one_owner_per_cloud';
 END IF;
END
$object_guard$;

DO $pod_414$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_index WHERE indexrelid='public.idx_personal_agent_registry_one_owner_per_cloud'::regclass AND indisvalid AND indisready) THEN RAISE EXCEPTION 'Private-agent index is not ready'; END IF;
END
$pod_414$;

DO $object_guard$
DECLARE actual text;
BEGIN
 SELECT definition INTO actual FROM (SELECT pg_get_indexdef(c.oid) definition FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname='idx_personal_agent_registry_status') observed;
 IF actual IS NULL THEN
  EXECUTE $object$CREATE INDEX idx_personal_agent_registry_status ON public.personal_agent_registry USING btree (status);$object$;
 ELSIF encode(sha256(convert_to(actual,'UTF8')),'hex') NOT IN ('c9c055056e35fe226fe523d9121093d1ea9010cab21be7c2e16b6a6e8f690e0e') THEN
  RAISE EXCEPTION 'Unqualified schema drift: idx_personal_agent_registry_status';
 END IF;
END
$object_guard$;

DO $pod_414$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_index WHERE indexrelid='public.idx_personal_agent_registry_status'::regclass AND indisvalid AND indisready) THEN RAISE EXCEPTION 'Private-agent index is not ready'; END IF;
END
$pod_414$;

DO $object_guard$
DECLARE actual text;
BEGIN
 SELECT definition INTO actual FROM (SELECT pg_get_indexdef(c.oid) definition FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname='idx_personal_agent_registry_user_cloud_project') observed;
 IF actual IS NULL THEN
  EXECUTE $object$CREATE INDEX idx_personal_agent_registry_user_cloud_project ON public.personal_agent_registry USING btree (user_cloud_project) WHERE (user_cloud_project IS NOT NULL);$object$;
 ELSIF encode(sha256(convert_to(actual,'UTF8')),'hex') NOT IN ('4d3e9c66b73507e475861b3e356f2e454997f84bee4c4b641f0e2137e28901d9') THEN
  RAISE EXCEPTION 'Unqualified schema drift: idx_personal_agent_registry_user_cloud_project';
 END IF;
END
$object_guard$;

DO $pod_414$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_index WHERE indexrelid='public.idx_personal_agent_registry_user_cloud_project'::regclass AND indisvalid AND indisready) THEN RAISE EXCEPTION 'Private-agent index is not ready'; END IF;
END
$pod_414$;

DO $object_guard$
DECLARE actual text;
BEGIN
 SELECT definition INTO actual FROM (SELECT pg_get_indexdef(c.oid) definition FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname='idx_personal_agent_standby_one_owner_per_azure_group') observed;
 IF actual IS NULL THEN
  EXECUTE $object$CREATE UNIQUE INDEX idx_personal_agent_standby_one_owner_per_azure_group ON public.personal_agent_standby_placements USING btree (user_cloud_tenant_id, user_cloud_subscription_id, user_cloud_resource_group) WHERE (deployment_target = 'user_azure'::text);$object$;
 ELSIF encode(sha256(convert_to(actual,'UTF8')),'hex') NOT IN ('fb6e24135ec7030e441b6cccad354079564fbca4856267d4a262ec124bcc5205') THEN
  RAISE EXCEPTION 'Unqualified schema drift: idx_personal_agent_standby_one_owner_per_azure_group';
 END IF;
END
$object_guard$;

DO $pod_414$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_index WHERE indexrelid='public.idx_personal_agent_standby_one_owner_per_azure_group'::regclass AND indisvalid AND indisready) THEN RAISE EXCEPTION 'Private-agent index is not ready'; END IF;
END
$pod_414$;

DO $object_guard$
DECLARE actual text;
BEGIN
 SELECT definition INTO actual FROM (SELECT pg_get_indexdef(c.oid) definition FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname='idx_personal_agent_standby_one_owner_per_cloud') observed;
 IF actual IS NULL THEN
  EXECUTE $object$CREATE UNIQUE INDEX idx_personal_agent_standby_one_owner_per_cloud ON public.personal_agent_standby_placements USING btree (user_cloud_project) WHERE ((deployment_target = 'user_gcp'::text) AND (user_cloud_project IS NOT NULL));$object$;
 ELSIF encode(sha256(convert_to(actual,'UTF8')),'hex') NOT IN ('f473a81888e52a202e8e829a2cc67852f9cb79bc59fbd3e5b23d9b4811c16f58') THEN
  RAISE EXCEPTION 'Unqualified schema drift: idx_personal_agent_standby_one_owner_per_cloud';
 END IF;
END
$object_guard$;

DO $pod_414$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_index WHERE indexrelid='public.idx_personal_agent_standby_one_owner_per_cloud'::regclass AND indisvalid AND indisready) THEN RAISE EXCEPTION 'Private-agent index is not ready'; END IF;
END
$pod_414$;

DO $object_guard$
DECLARE actual text;
BEGIN
 SELECT definition INTO actual FROM (SELECT pg_get_indexdef(c.oid) definition FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname='idx_personal_agent_standby_sync_attempt') observed;
 IF actual IS NULL THEN
  EXECUTE $object$CREATE INDEX idx_personal_agent_standby_sync_attempt ON public.personal_agent_standby_placements USING btree (last_sync_attempt_at NULLS FIRST);$object$;
 ELSIF encode(sha256(convert_to(actual,'UTF8')),'hex') NOT IN ('c4ee1362bb025e4c22a46cda5fbfca2eaa120747ac5b509e79cec29f08984060') THEN
  RAISE EXCEPTION 'Unqualified schema drift: idx_personal_agent_standby_sync_attempt';
 END IF;
END
$object_guard$;

DO $pod_414$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_index WHERE indexrelid='public.idx_personal_agent_standby_sync_attempt'::regclass AND indisvalid AND indisready) THEN RAISE EXCEPTION 'Private-agent index is not ready'; END IF;
END
$pod_414$;

DO $object_guard$
DECLARE actual text;
BEGIN
 SELECT definition INTO actual FROM (SELECT pg_get_indexdef(c.oid) definition FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname='idx_pod_lifecycle_expiry') observed;
 IF actual IS NULL THEN
  EXECUTE $object$CREATE INDEX idx_pod_lifecycle_expiry ON public.pod_lifecycle_events USING btree (expires_at);$object$;
 ELSIF encode(sha256(convert_to(actual,'UTF8')),'hex') NOT IN ('0d296be478cb58f48ebaa68b94967388142fc2c0e891ccb86f0ed5ed408cfdd7') THEN
  RAISE EXCEPTION 'Unqualified schema drift: idx_pod_lifecycle_expiry';
 END IF;
END
$object_guard$;

DO $pod_414$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_index WHERE indexrelid='public.idx_pod_lifecycle_expiry'::regclass AND indisvalid AND indisready) THEN RAISE EXCEPTION 'Private-agent index is not ready'; END IF;
END
$pod_414$;

DO $object_guard$
DECLARE actual text;
BEGIN
 SELECT definition INTO actual FROM (SELECT pg_get_indexdef(c.oid) definition FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname='idx_pod_migration_jobs_status_updated') observed;
 IF actual IS NULL THEN
  EXECUTE $object$CREATE INDEX idx_pod_migration_jobs_status_updated ON public.pod_migration_jobs USING btree (status, updated_at DESC);$object$;
 ELSIF encode(sha256(convert_to(actual,'UTF8')),'hex') NOT IN ('f28c5d1a596741b434ab9ebaee845463fbae06901b071b8479579e943857f67e') THEN
  RAISE EXCEPTION 'Unqualified schema drift: idx_pod_migration_jobs_status_updated';
 END IF;
END
$object_guard$;

DO $pod_414$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_index WHERE indexrelid='public.idx_pod_migration_jobs_status_updated'::regclass AND indisvalid AND indisready) THEN RAISE EXCEPTION 'Private-agent index is not ready'; END IF;
END
$pod_414$;

DO $object_guard$
DECLARE actual text;
BEGIN
 SELECT definition INTO actual FROM (SELECT pg_get_indexdef(c.oid) definition FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname='pod_request_nonces_expires_at_idx') observed;
 IF actual IS NULL THEN
  EXECUTE $object$CREATE INDEX pod_request_nonces_expires_at_idx ON public.pod_request_nonces USING btree (expires_at);$object$;
 ELSIF encode(sha256(convert_to(actual,'UTF8')),'hex') NOT IN ('692539be9a07654b33bc9cb508fa7d1c4564358cfd18881926aaf87b44585e0a') THEN
  RAISE EXCEPTION 'Unqualified schema drift: pod_request_nonces_expires_at_idx';
 END IF;
END
$object_guard$;

DO $pod_414$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_index WHERE indexrelid='public.pod_request_nonces_expires_at_idx'::regclass AND indisvalid AND indisready) THEN RAISE EXCEPTION 'Private-agent index is not ready'; END IF;
END
$pod_414$;

DO $object_guard$
DECLARE actual text;
BEGIN
 SELECT definition INTO actual FROM (SELECT pg_get_indexdef(c.oid) definition FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname='idx_webauthn_challenges_challenge') observed;
 IF actual IS NULL THEN
  EXECUTE $object$CREATE UNIQUE INDEX idx_webauthn_challenges_challenge ON public.webauthn_challenges USING btree (challenge);$object$;
 ELSIF encode(sha256(convert_to(actual,'UTF8')),'hex') NOT IN ('a96f32e3f41d1f2876a9e2c07810afd985653840cd3ab5f8f9d820f31644b800') THEN
  RAISE EXCEPTION 'Unqualified schema drift: idx_webauthn_challenges_challenge';
 END IF;
END
$object_guard$;

DO $pod_414$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_index WHERE indexrelid='public.idx_webauthn_challenges_challenge'::regclass AND indisvalid AND indisready) THEN RAISE EXCEPTION 'Private-agent index is not ready'; END IF;
END
$pod_414$;

DO $object_guard$
DECLARE actual text;
BEGIN
 SELECT definition INTO actual FROM (SELECT pg_get_indexdef(c.oid) definition FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname='idx_webauthn_challenges_expires') observed;
 IF actual IS NULL THEN
  EXECUTE $object$CREATE INDEX idx_webauthn_challenges_expires ON public.webauthn_challenges USING btree (expires_at);$object$;
 ELSIF encode(sha256(convert_to(actual,'UTF8')),'hex') NOT IN ('d77688f0a3986d2dc5bbf23a5516880f56a9041dcc6257b99aa5b2ed7b0a6e95') THEN
  RAISE EXCEPTION 'Unqualified schema drift: idx_webauthn_challenges_expires';
 END IF;
END
$object_guard$;

DO $pod_414$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_index WHERE indexrelid='public.idx_webauthn_challenges_expires'::regclass AND indisvalid AND indisready) THEN RAISE EXCEPTION 'Private-agent index is not ready'; END IF;
END
$pod_414$;

DO $object_guard$
DECLARE actual text;
BEGIN
 SELECT definition INTO actual FROM (SELECT pg_get_indexdef(c.oid) definition FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname='idx_webauthn_credentials_user') observed;
 IF actual IS NULL THEN
  EXECUTE $object$CREATE INDEX idx_webauthn_credentials_user ON public.webauthn_credentials USING btree (user_id);$object$;
 ELSIF encode(sha256(convert_to(actual,'UTF8')),'hex') NOT IN ('1bb3e2d3f1f75a1a224dd685d07692181eaa88629bc64f490fc3ee5cfb1d0084') THEN
  RAISE EXCEPTION 'Unqualified schema drift: idx_webauthn_credentials_user';
 END IF;
END
$object_guard$;

DO $pod_414$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_index WHERE indexrelid='public.idx_webauthn_credentials_user'::regclass AND indisvalid AND indisready) THEN RAISE EXCEPTION 'Private-agent index is not ready'; END IF;
END
$pod_414$;

DO $object_guard$
DECLARE actual text;
BEGIN
 SELECT definition INTO actual FROM (SELECT pg_get_constraintdef(k.oid,true) definition FROM pg_constraint k WHERE k.conrelid='public.agent_prompt_versions'::regclass AND k.conname='agent_prompt_versions_canary_pct_check') observed;
 IF actual IS NULL THEN
  EXECUTE $object$ALTER TABLE public."agent_prompt_versions" ADD CONSTRAINT "agent_prompt_versions_canary_pct_check" CHECK (canary_percent >= 0 AND canary_percent <= 100);$object$;
 ELSIF encode(sha256(convert_to(actual,'UTF8')),'hex') NOT IN ('f0986aa56b4db66eeeb39b4f75b16ac724be09d547fee4343b3a00e4e6f1e23f') THEN
  RAISE EXCEPTION 'Unqualified schema drift: agent_prompt_versions_canary_pct_check';
 END IF;
END
$object_guard$;

DO $object_guard$
DECLARE actual text;
BEGIN
 SELECT definition INTO actual FROM (SELECT pg_get_constraintdef(k.oid,true) definition FROM pg_constraint k WHERE k.conrelid='public.agent_prompt_versions'::regclass AND k.conname='agent_prompt_versions_pkey') observed;
 IF actual IS NULL THEN
  EXECUTE $object$ALTER TABLE public."agent_prompt_versions" ADD CONSTRAINT "agent_prompt_versions_pkey" PRIMARY KEY (id);$object$;
 ELSIF encode(sha256(convert_to(actual,'UTF8')),'hex') NOT IN ('8c8464f42472e42ee190fc91ca8db79b5351d3a4609040516578d229c56f6fa5') THEN
  RAISE EXCEPTION 'Unqualified schema drift: agent_prompt_versions_pkey';
 END IF;
END
$object_guard$;

DO $object_guard$
DECLARE actual text;
BEGIN
 SELECT definition INTO actual FROM (SELECT pg_get_constraintdef(k.oid,true) definition FROM pg_constraint k WHERE k.conrelid='public.agent_prompt_versions'::regclass AND k.conname='agent_prompt_versions_status_check') observed;
 IF actual IS NULL THEN
  EXECUTE $object$ALTER TABLE public."agent_prompt_versions" ADD CONSTRAINT "agent_prompt_versions_status_check" CHECK (status = ANY (ARRAY['active'::text, 'canary'::text, 'retired'::text]));$object$;
 ELSIF encode(sha256(convert_to(actual,'UTF8')),'hex') NOT IN ('95d2f0967a57facb0cf258326915072153986b0240c95a40cb457971661d29c1') THEN
  RAISE EXCEPTION 'Unqualified schema drift: agent_prompt_versions_status_check';
 END IF;
END
$object_guard$;

DO $object_guard$
DECLARE actual text;
BEGIN
 SELECT definition INTO actual FROM (SELECT pg_get_constraintdef(k.oid,true) definition FROM pg_constraint k WHERE k.conrelid='public.consent_audit_receipts'::regclass AND k.conname='consent_audit_receipts_pkey') observed;
 IF actual IS NULL THEN
  EXECUTE $object$ALTER TABLE public."consent_audit_receipts" ADD CONSTRAINT "consent_audit_receipts_pkey" PRIMARY KEY (id);$object$;
 ELSIF encode(sha256(convert_to(actual,'UTF8')),'hex') NOT IN ('8c8464f42472e42ee190fc91ca8db79b5351d3a4609040516578d229c56f6fa5') THEN
  RAISE EXCEPTION 'Unqualified schema drift: consent_audit_receipts_pkey';
 END IF;
END
$object_guard$;

DO $object_guard$
DECLARE actual text;
BEGIN
 SELECT definition INTO actual FROM (SELECT pg_get_constraintdef(k.oid,true) definition FROM pg_constraint k WHERE k.conrelid='public.consent_audit_receipts'::regclass AND k.conname='consent_audit_receipts_subject_id_ledger_hash_key') observed;
 IF actual IS NULL THEN
  EXECUTE $object$ALTER TABLE public."consent_audit_receipts" ADD CONSTRAINT "consent_audit_receipts_subject_id_ledger_hash_key" UNIQUE (subject_id, ledger, hash);$object$;
 ELSIF encode(sha256(convert_to(actual,'UTF8')),'hex') NOT IN ('3dd8b41ddede5969d6f1e78711de6ffd913ff97a0f84b0f8a3e8825a74dedcd9') THEN
  RAISE EXCEPTION 'Unqualified schema drift: consent_audit_receipts_subject_id_ledger_hash_key';
 END IF;
END
$object_guard$;

DO $object_guard$
DECLARE actual text;
BEGIN
 SELECT definition INTO actual FROM (SELECT pg_get_constraintdef(k.oid,true) definition FROM pg_constraint k WHERE k.conrelid='public.consent_audit_receipts'::regclass AND k.conname='consent_audit_receipts_subject_id_ledger_seq_key') observed;
 IF actual IS NULL THEN
  EXECUTE $object$ALTER TABLE public."consent_audit_receipts" ADD CONSTRAINT "consent_audit_receipts_subject_id_ledger_seq_key" UNIQUE (subject_id, ledger, seq);$object$;
 ELSIF encode(sha256(convert_to(actual,'UTF8')),'hex') NOT IN ('aed5f9ab529b9678ce068697f0e64da2db9d944ffd83b0c4d154de602b0af677') THEN
  RAISE EXCEPTION 'Unqualified schema drift: consent_audit_receipts_subject_id_ledger_seq_key';
 END IF;
END
$object_guard$;

DO $object_guard$
DECLARE actual text;
BEGIN
 SELECT definition INTO actual FROM (SELECT pg_get_constraintdef(k.oid,true) definition FROM pg_constraint k WHERE k.conrelid='public.one_action_directive_ledger'::regclass AND k.conname='one_action_directive_ledger_channel_check') observed;
 IF actual IS NULL THEN
  RAISE EXCEPTION 'Missing qualified object: one_action_directive_ledger_channel_check';
 ELSIF encode(sha256(convert_to(actual,'UTF8')),'hex') NOT IN ('fb2eb7cced6f86502a314b15b16491a4fb58bf38e28e4adae02b83f435be5676','4e46a8350cad500eb222cdf13987e561274c67d7910c7d9c4463578d2bc5be29') THEN
  RAISE EXCEPTION 'Unqualified schema drift: one_action_directive_ledger_channel_check';
 END IF;
END
$object_guard$;

DO $pod_414$
BEGIN
 IF (SELECT pg_get_constraintdef(k.oid,true) definition FROM pg_constraint k WHERE k.conrelid='public.one_action_directive_ledger'::regclass AND k.conname='one_action_directive_ledger_channel_check')='CHECK (channel = ANY (ARRAY[''typed_chat''::text, ''voice''::text, ''command''::text, ''document_review''::text, ''adk_chat''::text]))' THEN ALTER TABLE public."one_action_directive_ledger" DROP CONSTRAINT "one_action_directive_ledger_channel_check"; ALTER TABLE public."one_action_directive_ledger" ADD CONSTRAINT "one_action_directive_ledger_channel_check" CHECK (channel = ANY (ARRAY['typed_chat'::text, 'voice'::text, 'command'::text, 'document_review'::text, 'adk_chat'::text, 'pod_chat'::text])); END IF;
END
$pod_414$;

DO $pod_414$
BEGIN
 IF obj_description((SELECT oid FROM pg_constraint WHERE conrelid='public.one_action_directive_ledger'::regclass AND conname='one_action_directive_ledger_channel_check'),'pg_constraint') IS NULL THEN COMMENT ON CONSTRAINT "one_action_directive_ledger_channel_check" ON public."one_action_directive_ledger" IS 'private-action-channel.v1/418'; END IF;
END
$pod_414$;

DO $object_guard$
DECLARE actual text;
BEGIN
 SELECT definition INTO actual FROM (SELECT pg_get_constraintdef(k.oid,true) definition FROM pg_constraint k WHERE k.conrelid='public.one_action_directive_ledger'::regclass AND k.conname='one_action_directive_ledger_check') observed;
 IF actual IS NULL THEN
  RAISE EXCEPTION 'Missing qualified object: one_action_directive_ledger_check';
 ELSIF encode(sha256(convert_to(actual,'UTF8')),'hex') NOT IN ('a5bebe9213a84d969cd4aa5da6df771c9fe16aa4887cb6cd12b8b2b47117dc2c','8c35eaaf7e569203ec9e384d6a0cdb32756bac69c4cfe138bca0c02cb26a587c') THEN
  RAISE EXCEPTION 'Unqualified schema drift: one_action_directive_ledger_check';
 END IF;
END
$object_guard$;

DO $pod_414$
BEGIN
 IF (SELECT pg_get_constraintdef(k.oid,true) definition FROM pg_constraint k WHERE k.conrelid='public.one_action_directive_ledger'::regclass AND k.conname='one_action_directive_ledger_check')='CHECK (channel = ''typed_chat''::text AND conversation_id IS NOT NULL AND session_id IS NULL OR (channel = ANY (ARRAY[''voice''::text, ''command''::text, ''adk_chat''::text])) AND session_id IS NOT NULL AND conversation_id IS NULL OR channel = ''document_review''::text AND conversation_id IS NULL AND session_id IS NULL)' THEN ALTER TABLE public."one_action_directive_ledger" DROP CONSTRAINT "one_action_directive_ledger_check"; ALTER TABLE public."one_action_directive_ledger" ADD CONSTRAINT "one_action_directive_ledger_check" CHECK (channel = 'typed_chat'::text AND conversation_id IS NOT NULL AND session_id IS NULL OR (channel = ANY (ARRAY['voice'::text, 'command'::text, 'adk_chat'::text, 'pod_chat'::text])) AND session_id IS NOT NULL AND conversation_id IS NULL OR channel = 'document_review'::text AND conversation_id IS NULL AND session_id IS NULL); END IF;
END
$pod_414$;

DO $pod_414$
BEGIN
 IF obj_description((SELECT oid FROM pg_constraint WHERE conrelid='public.one_action_directive_ledger'::regclass AND conname='one_action_directive_ledger_check'),'pg_constraint') IS NULL THEN COMMENT ON CONSTRAINT "one_action_directive_ledger_check" ON public."one_action_directive_ledger" IS 'private-action-channel.v1/418'; END IF;
END
$pod_414$;

DO $object_guard$
DECLARE actual text;
BEGIN
 SELECT definition INTO actual FROM (SELECT pg_get_constraintdef(k.oid,true) definition FROM pg_constraint k WHERE k.conrelid='public.one_action_directive_ledger'::regclass AND k.conname='pod_chat_action_identity') observed;
 IF actual IS NULL THEN
  EXECUTE $object$ALTER TABLE public."one_action_directive_ledger" ADD CONSTRAINT "pod_chat_action_identity" CHECK (channel <> 'pod_chat'::text OR adk_app_name IS NULL AND (action_id = ANY (ARRAY['connector.mcp.invoke'::text, 'browser.model_process'::text, 'browser.disclose'::text, 'browser.session_remember'::text, 'browser.session_restore'::text, 'browser.provider_safety'::text])) AND requires_confirmation AND trusted_activation_required AND resource_binding_hmac IS NOT NULL);$object$;
 ELSIF encode(sha256(convert_to(actual,'UTF8')),'hex') NOT IN ('1c16c3cfaebc4cdef0fa7e90b1a08f1428cb1406922e07ae213a73b985cf0aac') THEN
  RAISE EXCEPTION 'Unqualified schema drift: pod_chat_action_identity';
 END IF;
END
$object_guard$;

DO $object_guard$
DECLARE actual text;
BEGIN
 SELECT definition INTO actual FROM (SELECT pg_get_constraintdef(k.oid,true) definition FROM pg_constraint k WHERE k.conrelid='public.personal_agent_cloud_removals'::regclass AND k.conname='personal_agent_cloud_removals_approved_digest_check') observed;
 IF actual IS NULL THEN
  EXECUTE $object$ALTER TABLE public."personal_agent_cloud_removals" ADD CONSTRAINT "personal_agent_cloud_removals_approved_digest_check" CHECK (approved_digest ~ '^[0-9a-f]{64}$'::text);$object$;
 ELSIF encode(sha256(convert_to(actual,'UTF8')),'hex') NOT IN ('81f741d7434accda53330728f5c25e343b37c5d808185421ea785ab126e80927') THEN
  RAISE EXCEPTION 'Unqualified schema drift: personal_agent_cloud_removals_approved_digest_check';
 END IF;
END
$object_guard$;

DO $object_guard$
DECLARE actual text;
BEGIN
 SELECT definition INTO actual FROM (SELECT pg_get_constraintdef(k.oid,true) definition FROM pg_constraint k WHERE k.conrelid='public.personal_agent_cloud_removals'::regclass AND k.conname='personal_agent_cloud_removals_archive_check') observed;
 IF actual IS NULL THEN
  EXECUTE $object$ALTER TABLE public."personal_agent_cloud_removals" ADD CONSTRAINT "personal_agent_cloud_removals_archive_check" CHECK (archive IS NULL OR jsonb_typeof(archive) = 'object'::text AND octet_length(archive::text) <= 2097152);$object$;
 ELSIF encode(sha256(convert_to(actual,'UTF8')),'hex') NOT IN ('ded59f2a11da24c0b3d0271854054e26b68819af8a86027b94631d524face232') THEN
  RAISE EXCEPTION 'Unqualified schema drift: personal_agent_cloud_removals_archive_check';
 END IF;
END
$object_guard$;

DO $object_guard$
DECLARE actual text;
BEGIN
 SELECT definition INTO actual FROM (SELECT pg_get_constraintdef(k.oid,true) definition FROM pg_constraint k WHERE k.conrelid='public.personal_agent_cloud_removals'::regclass AND k.conname='personal_agent_cloud_removals_check') observed;
 IF actual IS NULL THEN
  EXECUTE $object$ALTER TABLE public."personal_agent_cloud_removals" ADD CONSTRAINT "personal_agent_cloud_removals_check" CHECK ((approved_digest IS NULL) = (approved_at IS NULL));$object$;
 ELSIF encode(sha256(convert_to(actual,'UTF8')),'hex') NOT IN ('ca9a6389e9c5eca0ec84bbcc2a894f1a8e5bfa58bdb1bfe88bde3f31e746b7b6') THEN
  RAISE EXCEPTION 'Unqualified schema drift: personal_agent_cloud_removals_check';
 END IF;
END
$object_guard$;

DO $object_guard$
DECLARE actual text;
BEGIN
 SELECT definition INTO actual FROM (SELECT pg_get_constraintdef(k.oid,true) definition FROM pg_constraint k WHERE k.conrelid='public.personal_agent_cloud_removals'::regclass AND k.conname='personal_agent_cloud_removals_check1') observed;
 IF actual IS NULL THEN
  EXECUTE $object$ALTER TABLE public."personal_agent_cloud_removals" ADD CONSTRAINT "personal_agent_cloud_removals_check1" CHECK ((completed_at IS NULL) = (archive IS NULL));$object$;
 ELSIF encode(sha256(convert_to(actual,'UTF8')),'hex') NOT IN ('63b6a07fe74ec4f841be59c4dd8b7a41224d072c833c75ffbf8ad94342b63c16') THEN
  RAISE EXCEPTION 'Unqualified schema drift: personal_agent_cloud_removals_check1';
 END IF;
END
$object_guard$;

DO $object_guard$
DECLARE actual text;
BEGIN
 SELECT definition INTO actual FROM (SELECT pg_get_constraintdef(k.oid,true) definition FROM pg_constraint k WHERE k.conrelid='public.personal_agent_cloud_removals'::regclass AND k.conname='personal_agent_cloud_removals_check2') observed;
 IF actual IS NULL THEN
  EXECUTE $object$ALTER TABLE public."personal_agent_cloud_removals" ADD CONSTRAINT "personal_agent_cloud_removals_check2" CHECK ((completed_at IS NULL) = (released_identity IS NULL));$object$;
 ELSIF encode(sha256(convert_to(actual,'UTF8')),'hex') NOT IN ('572171d18acebd8348d02adfb6ba2359aa75cf0d2ed70ed61dd02161845811a6') THEN
  RAISE EXCEPTION 'Unqualified schema drift: personal_agent_cloud_removals_check2';
 END IF;
END
$object_guard$;

DO $object_guard$
DECLARE actual text;
BEGIN
 SELECT definition INTO actual FROM (SELECT pg_get_constraintdef(k.oid,true) definition FROM pg_constraint k WHERE k.conrelid='public.personal_agent_cloud_removals'::regclass AND k.conname='personal_agent_cloud_removals_pkey') observed;
 IF actual IS NULL THEN
  EXECUTE $object$ALTER TABLE public."personal_agent_cloud_removals" ADD CONSTRAINT "personal_agent_cloud_removals_pkey" PRIMARY KEY (user_id, attempt_id);$object$;
 ELSIF encode(sha256(convert_to(actual,'UTF8')),'hex') NOT IN ('bbd62795ec4c0ae941a0941bf7a5a112cc8f4838c3ef490fbbe5be5ed2df1862') THEN
  RAISE EXCEPTION 'Unqualified schema drift: personal_agent_cloud_removals_pkey';
 END IF;
END
$object_guard$;

DO $object_guard$
DECLARE actual text;
BEGIN
 SELECT definition INTO actual FROM (SELECT pg_get_constraintdef(k.oid,true) definition FROM pg_constraint k WHERE k.conrelid='public.personal_agent_cloud_removals'::regclass AND k.conname='personal_agent_cloud_removals_placement_epoch_check') observed;
 IF actual IS NULL THEN
  EXECUTE $object$ALTER TABLE public."personal_agent_cloud_removals" ADD CONSTRAINT "personal_agent_cloud_removals_placement_epoch_check" CHECK (placement_epoch >= 0);$object$;
 ELSIF encode(sha256(convert_to(actual,'UTF8')),'hex') NOT IN ('e9dfaeeb6f6730c912af1f4c4e796da7794f4b1c0b772931c727ec4da7307833') THEN
  RAISE EXCEPTION 'Unqualified schema drift: personal_agent_cloud_removals_placement_epoch_check';
 END IF;
END
$object_guard$;

DO $object_guard$
DECLARE actual text;
BEGIN
 SELECT definition INTO actual FROM (SELECT pg_get_constraintdef(k.oid,true) definition FROM pg_constraint k WHERE k.conrelid='public.personal_agent_cloud_removals'::regclass AND k.conname='personal_agent_cloud_removals_snapshot_sha256_check') observed;
 IF actual IS NULL THEN
  EXECUTE $object$ALTER TABLE public."personal_agent_cloud_removals" ADD CONSTRAINT "personal_agent_cloud_removals_snapshot_sha256_check" CHECK (snapshot_sha256 ~ '^[0-9a-f]{64}$'::text);$object$;
 ELSIF encode(sha256(convert_to(actual,'UTF8')),'hex') NOT IN ('97d7097ada68abeb0c3082d52e55cd794d0218553413e6899a40fa9956ae707c') THEN
  RAISE EXCEPTION 'Unqualified schema drift: personal_agent_cloud_removals_snapshot_sha256_check';
 END IF;
END
$object_guard$;

DO $object_guard$
DECLARE actual text;
BEGIN
 SELECT definition INTO actual FROM (SELECT pg_get_constraintdef(k.oid,true) definition FROM pg_constraint k WHERE k.conrelid='public.personal_agent_deletion_tombstones'::regclass AND k.conname='personal_agent_deletion_tombstones_pkey') observed;
 IF actual IS NULL THEN
  EXECUTE $object$ALTER TABLE public."personal_agent_deletion_tombstones" ADD CONSTRAINT "personal_agent_deletion_tombstones_pkey" PRIMARY KEY (id);$object$;
 ELSIF encode(sha256(convert_to(actual,'UTF8')),'hex') NOT IN ('8c8464f42472e42ee190fc91ca8db79b5351d3a4609040516578d229c56f6fa5') THEN
  RAISE EXCEPTION 'Unqualified schema drift: personal_agent_deletion_tombstones_pkey';
 END IF;
END
$object_guard$;

DO $object_guard$
DECLARE actual text;
BEGIN
 SELECT definition INTO actual FROM (SELECT pg_get_constraintdef(k.oid,true) definition FROM pg_constraint k WHERE k.conrelid='public.personal_agent_registry'::regclass AND k.conname='personal_agent_registry_azure_ids_shape_check') observed;
 IF actual IS NULL THEN
  EXECUTE $object$ALTER TABLE public."personal_agent_registry" ADD CONSTRAINT "personal_agent_registry_azure_ids_shape_check" CHECK ((user_cloud_tenant_id IS NULL OR user_cloud_tenant_id ~ '^[0-9a-f]{8}-([0-9a-f]{4}-){3}[0-9a-f]{12}$'::text) AND (user_cloud_subscription_id IS NULL OR user_cloud_subscription_id ~ '^[0-9a-f]{8}-([0-9a-f]{4}-){3}[0-9a-f]{12}$'::text));$object$;
 ELSIF encode(sha256(convert_to(actual,'UTF8')),'hex') NOT IN ('5857973f706363cfeb309b01abfdaa85b81d00154a8feccfcc08612275947cb3') THEN
  RAISE EXCEPTION 'Unqualified schema drift: personal_agent_registry_azure_ids_shape_check';
 END IF;
END
$object_guard$;

DO $object_guard$
DECLARE actual text;
BEGIN
 SELECT definition INTO actual FROM (SELECT pg_get_constraintdef(k.oid,true) definition FROM pg_constraint k WHERE k.conrelid='public.personal_agent_registry'::regclass AND k.conname='personal_agent_registry_deployment_target_check') observed;
 IF actual IS NULL THEN
  EXECUTE $object$ALTER TABLE public."personal_agent_registry" ADD CONSTRAINT "personal_agent_registry_deployment_target_check" CHECK (deployment_target IS NULL OR (deployment_target = ANY (ARRAY['gcp'::text, 'user_gcp'::text, 'user_azure'::text, 'null'::text])));$object$;
 ELSIF encode(sha256(convert_to(actual,'UTF8')),'hex') NOT IN ('15c9243d622f15d2ca2690cb232af88e3e51b5d586e72042b9000177cc4cc300') THEN
  RAISE EXCEPTION 'Unqualified schema drift: personal_agent_registry_deployment_target_check';
 END IF;
END
$object_guard$;

DO $object_guard$
DECLARE actual text;
BEGIN
 SELECT definition INTO actual FROM (SELECT pg_get_constraintdef(k.oid,true) definition FROM pg_constraint k WHERE k.conrelid='public.personal_agent_registry'::regclass AND k.conname='personal_agent_registry_health_state_check') observed;
 IF actual IS NULL THEN
  EXECUTE $object$ALTER TABLE public."personal_agent_registry" ADD CONSTRAINT "personal_agent_registry_health_state_check" CHECK (health_state = ANY (ARRAY['unknown'::text, 'healthy'::text, 'degraded'::text, 'unreachable'::text, 'sleeping'::text]));$object$;
 ELSIF encode(sha256(convert_to(actual,'UTF8')),'hex') NOT IN ('10b00c77ace20ce8994c04a8ded334d34a77489ec93790256f7d08f40adf9cb0') THEN
  RAISE EXCEPTION 'Unqualified schema drift: personal_agent_registry_health_state_check';
 END IF;
END
$object_guard$;

DO $object_guard$
DECLARE actual text;
BEGIN
 SELECT definition INTO actual FROM (SELECT pg_get_constraintdef(k.oid,true) definition FROM pg_constraint k WHERE k.conrelid='public.personal_agent_registry'::regclass AND k.conname='personal_agent_registry_identity_mode_check') observed;
 IF actual IS NULL THEN
  EXECUTE $object$ALTER TABLE public."personal_agent_registry" ADD CONSTRAINT "personal_agent_registry_identity_mode_check" CHECK (identity_mode IS NULL OR identity_mode = 'signed'::text);$object$;
 ELSIF encode(sha256(convert_to(actual,'UTF8')),'hex') NOT IN ('db476755803c35bf2c0bc296af8c95195bb2a6a65047858522b9658af3f41950') THEN
  RAISE EXCEPTION 'Unqualified schema drift: personal_agent_registry_identity_mode_check';
 END IF;
END
$object_guard$;

DO $object_guard$
DECLARE actual text;
BEGIN
 SELECT definition INTO actual FROM (SELECT pg_get_constraintdef(k.oid,true) definition FROM pg_constraint k WHERE k.conrelid='public.personal_agent_registry'::regclass AND k.conname='personal_agent_registry_liveness_mode_check') observed;
 IF actual IS NULL THEN
  EXECUTE $object$ALTER TABLE public."personal_agent_registry" ADD CONSTRAINT "personal_agent_registry_liveness_mode_check" CHECK (liveness_mode = ANY (ARRAY['warm'::text, 'economy'::text]));$object$;
 ELSIF encode(sha256(convert_to(actual,'UTF8')),'hex') NOT IN ('10afc98516380fd1bb8830ffb9e0e3cdf772b39e09b17c3c919ef4b9d2f5994f') THEN
  RAISE EXCEPTION 'Unqualified schema drift: personal_agent_registry_liveness_mode_check';
 END IF;
END
$object_guard$;

DO $object_guard$
DECLARE actual text;
BEGIN
 SELECT definition INTO actual FROM (SELECT pg_get_constraintdef(k.oid,true) definition FROM pg_constraint k WHERE k.conrelid='public.personal_agent_registry'::regclass AND k.conname='personal_agent_registry_model_credential_mode_check') observed;
 IF actual IS NULL THEN
  EXECUTE $object$ALTER TABLE public."personal_agent_registry" ADD CONSTRAINT "personal_agent_registry_model_credential_mode_check" CHECK (model_credential_mode IS NULL OR (model_credential_mode = ANY (ARRAY['user_adc'::text, 'byok_per_turn'::text, 'fleet_adc'::text, 'user_azure_mi'::text])));$object$;
 ELSIF encode(sha256(convert_to(actual,'UTF8')),'hex') NOT IN ('03b2cc3705300b7115c1806556abb0ec275507605d4653efa52555c7e1d02ef3') THEN
  RAISE EXCEPTION 'Unqualified schema drift: personal_agent_registry_model_credential_mode_check';
 END IF;
END
$object_guard$;

DO $object_guard$
DECLARE actual text;
BEGIN
 SELECT definition INTO actual FROM (SELECT pg_get_constraintdef(k.oid,true) definition FROM pg_constraint k WHERE k.conrelid='public.personal_agent_registry'::regclass AND k.conname='personal_agent_registry_placement_epoch_check') observed;
 IF actual IS NULL THEN
  EXECUTE $object$ALTER TABLE public."personal_agent_registry" ADD CONSTRAINT "personal_agent_registry_placement_epoch_check" CHECK (placement_epoch >= 0);$object$;
 ELSIF encode(sha256(convert_to(actual,'UTF8')),'hex') NOT IN ('e9dfaeeb6f6730c912af1f4c4e796da7794f4b1c0b772931c727ec4da7307833') THEN
  RAISE EXCEPTION 'Unqualified schema drift: personal_agent_registry_placement_epoch_check';
 END IF;
END
$object_guard$;

DO $object_guard$
DECLARE actual text;
BEGIN
 SELECT definition INTO actual FROM (SELECT pg_get_constraintdef(k.oid,true) definition FROM pg_constraint k WHERE k.conrelid='public.personal_agent_registry'::regclass AND k.conname='personal_agent_registry_pod_signing_key_check') observed;
 IF actual IS NULL THEN
  EXECUTE $object$ALTER TABLE public."personal_agent_registry" ADD CONSTRAINT "personal_agent_registry_pod_signing_key_check" CHECK ((pod_signing_pubkey IS NULL) = (pod_signing_key_id IS NULL) AND (pod_signing_pubkey IS NULL OR pod_pubkey IS NOT NULL) AND (pod_signing_pubkey IS NULL OR pod_signing_pubkey ~ '^[A-Za-z0-9+/]{43}=$'::text) AND (pod_signing_key_id IS NULL OR pod_signing_key_id ~ '^pods_[0-9a-f]{32}$'::text));$object$;
 ELSIF encode(sha256(convert_to(actual,'UTF8')),'hex') NOT IN ('43b1c23063ddb764e5f428ca1fa2513650ea512c046407c265d6272dfb02ded7') THEN
  RAISE EXCEPTION 'Unqualified schema drift: personal_agent_registry_pod_signing_key_check';
 END IF;
END
$object_guard$;

DO $object_guard$
DECLARE actual text;
BEGIN
 SELECT definition INTO actual FROM (SELECT pg_get_constraintdef(k.oid,true) definition FROM pg_constraint k WHERE k.conrelid='public.personal_agent_registry'::regclass AND k.conname='personal_agent_registry_status_check') observed;
 IF actual IS NULL THEN
  EXECUTE $object$ALTER TABLE public."personal_agent_registry" ADD CONSTRAINT "personal_agent_registry_status_check" CHECK (status = ANY (ARRAY['unprovisioned'::text, 'pending'::text, 'provisioning'::text, 'connecting'::text, 'provisioned'::text, 'provisioning_failed'::text, 'needs_reinit'::text, 'migrating'::text, 'reaped'::text, 'suspended'::text]));$object$;
 ELSIF encode(sha256(convert_to(actual,'UTF8')),'hex') NOT IN ('e95bfe7efd8c4c91b3f2ccc2d1defc567ad10a3dcc7734007d1828b9d333c18f') THEN
  RAISE EXCEPTION 'Unqualified schema drift: personal_agent_registry_status_check';
 END IF;
END
$object_guard$;

DO $object_guard$
DECLARE actual text;
BEGIN
 SELECT definition INTO actual FROM (SELECT pg_get_constraintdef(k.oid,true) definition FROM pg_constraint k WHERE k.conrelid='public.personal_agent_registry'::regclass AND k.conname='personal_agent_registry_user_azure_needs_coordinates_check') observed;
 IF actual IS NULL THEN
  EXECUTE $object$ALTER TABLE public."personal_agent_registry" ADD CONSTRAINT "personal_agent_registry_user_azure_needs_coordinates_check" CHECK (deployment_target IS DISTINCT FROM 'user_azure'::text OR user_cloud_tenant_id IS NOT NULL AND user_cloud_subscription_id IS NOT NULL AND user_cloud_resource_group IS NOT NULL AND user_cloud_region IS NOT NULL);$object$;
 ELSIF encode(sha256(convert_to(actual,'UTF8')),'hex') NOT IN ('0d2b7d2ac2d02e6f72e5a01068e07ff77a23c51277e7a9c561391e9d574e031b') THEN
  RAISE EXCEPTION 'Unqualified schema drift: personal_agent_registry_user_azure_needs_coordinates_check';
 END IF;
END
$object_guard$;

DO $object_guard$
DECLARE actual text;
BEGIN
 SELECT definition INTO actual FROM (SELECT pg_get_constraintdef(k.oid,true) definition FROM pg_constraint k WHERE k.conrelid='public.personal_agent_registry'::regclass AND k.conname='personal_agent_registry_user_gcp_needs_project_check') observed;
 IF actual IS NULL THEN
  EXECUTE $object$ALTER TABLE public."personal_agent_registry" ADD CONSTRAINT "personal_agent_registry_user_gcp_needs_project_check" CHECK (deployment_target IS DISTINCT FROM 'user_gcp'::text OR user_cloud_project IS NOT NULL);$object$;
 ELSIF encode(sha256(convert_to(actual,'UTF8')),'hex') NOT IN ('a04b90e94c09d822c72c99ce78dcc2065f81a62d9353487e7fd872bf5db972db') THEN
  RAISE EXCEPTION 'Unqualified schema drift: personal_agent_registry_user_gcp_needs_project_check';
 END IF;
END
$object_guard$;

DO $object_guard$
DECLARE actual text;
BEGIN
 SELECT definition INTO actual FROM (SELECT pg_get_constraintdef(k.oid,true) definition FROM pg_constraint k WHERE k.conrelid='public.personal_agent_standby_placements'::regclass AND k.conname='personal_agent_standby_azure_ids_shape_check') observed;
 IF actual IS NULL THEN
  EXECUTE $object$ALTER TABLE public."personal_agent_standby_placements" ADD CONSTRAINT "personal_agent_standby_azure_ids_shape_check" CHECK ((user_cloud_tenant_id IS NULL OR user_cloud_tenant_id ~ '^[0-9a-f]{8}-([0-9a-f]{4}-){3}[0-9a-f]{12}$'::text) AND (user_cloud_subscription_id IS NULL OR user_cloud_subscription_id ~ '^[0-9a-f]{8}-([0-9a-f]{4}-){3}[0-9a-f]{12}$'::text));$object$;
 ELSIF encode(sha256(convert_to(actual,'UTF8')),'hex') NOT IN ('5857973f706363cfeb309b01abfdaa85b81d00154a8feccfcc08612275947cb3') THEN
  RAISE EXCEPTION 'Unqualified schema drift: personal_agent_standby_azure_ids_shape_check';
 END IF;
END
$object_guard$;

DO $object_guard$
DECLARE actual text;
BEGIN
 SELECT definition INTO actual FROM (SELECT pg_get_constraintdef(k.oid,true) definition FROM pg_constraint k WHERE k.conrelid='public.personal_agent_standby_placements'::regclass AND k.conname='personal_agent_standby_lease_check') observed;
 IF actual IS NULL THEN
  EXECUTE $object$ALTER TABLE public."personal_agent_standby_placements" ADD CONSTRAINT "personal_agent_standby_lease_check" CHECK ((sync_lease_id IS NULL) = (sync_lease_at IS NULL) AND (sync_lease_id IS NULL OR sync_lease_id ~ '^[0-9a-f]{32}$'::text));$object$;
 ELSIF encode(sha256(convert_to(actual,'UTF8')),'hex') NOT IN ('4ced80ee5c315243fb319afbaadbe0d9c1da5c84df0067f942ca043eb4d65e65') THEN
  RAISE EXCEPTION 'Unqualified schema drift: personal_agent_standby_lease_check';
 END IF;
END
$object_guard$;

DO $object_guard$
DECLARE actual text;
BEGIN
 SELECT definition INTO actual FROM (SELECT pg_get_constraintdef(k.oid,true) definition FROM pg_constraint k WHERE k.conrelid='public.personal_agent_standby_placements'::regclass AND k.conname='personal_agent_standby_metadata_check') observed;
 IF actual IS NULL THEN
  EXECUTE $object$ALTER TABLE public."personal_agent_standby_placements" ADD CONSTRAINT "personal_agent_standby_metadata_check" CHECK (jsonb_typeof(backend_metadata) = 'object'::text AND NOT backend_metadata ?| ARRAY['erasure'::text, 'upgradeLease'::text, 'detachedPlacements'::text, 'url'::text] AND (NOT backend_metadata ? 'provisionAttempt'::text OR ((backend_metadata -> 'provisionAttempt'::text) ->> 'phase'::text) = 'provisioned'::text));$object$;
 ELSIF encode(sha256(convert_to(actual,'UTF8')),'hex') NOT IN ('dfd60fa47de963ab2008c16460da6b2028dbca02bba85dae80718bb605b52497') THEN
  RAISE EXCEPTION 'Unqualified schema drift: personal_agent_standby_metadata_check';
 END IF;
END
$object_guard$;

DO $object_guard$
DECLARE actual text;
BEGIN
 SELECT definition INTO actual FROM (SELECT pg_get_constraintdef(k.oid,true) definition FROM pg_constraint k WHERE k.conrelid='public.personal_agent_standby_placements'::regclass AND k.conname='personal_agent_standby_model_mode_check') observed;
 IF actual IS NULL THEN
  EXECUTE $object$ALTER TABLE public."personal_agent_standby_placements" ADD CONSTRAINT "personal_agent_standby_model_mode_check" CHECK (model_credential_mode IS NULL OR (model_credential_mode = ANY (ARRAY['user_adc'::text, 'byok_per_turn'::text, 'fleet_adc'::text, 'user_azure_mi'::text])));$object$;
 ELSIF encode(sha256(convert_to(actual,'UTF8')),'hex') NOT IN ('03b2cc3705300b7115c1806556abb0ec275507605d4653efa52555c7e1d02ef3') THEN
  RAISE EXCEPTION 'Unqualified schema drift: personal_agent_standby_model_mode_check';
 END IF;
END
$object_guard$;

DO $object_guard$
DECLARE actual text;
BEGIN
 SELECT definition INTO actual FROM (SELECT pg_get_constraintdef(k.oid,true) definition FROM pg_constraint k WHERE k.conrelid='public.personal_agent_standby_placements'::regclass AND k.conname='personal_agent_standby_placements_pkey') observed;
 IF actual IS NULL THEN
  EXECUTE $object$ALTER TABLE public."personal_agent_standby_placements" ADD CONSTRAINT "personal_agent_standby_placements_pkey" PRIMARY KEY (user_id);$object$;
 ELSIF encode(sha256(convert_to(actual,'UTF8')),'hex') NOT IN ('44756d887704fc88d8d0adc5c0c431103c555b4f8e6a4ddef6f7a7f6b4110606') THEN
  RAISE EXCEPTION 'Unqualified schema drift: personal_agent_standby_placements_pkey';
 END IF;
END
$object_guard$;

DO $object_guard$
DECLARE actual text;
BEGIN
 SELECT definition INTO actual FROM (SELECT pg_get_constraintdef(k.oid,true) definition FROM pg_constraint k WHERE k.conrelid='public.personal_agent_standby_placements'::regclass AND k.conname='personal_agent_standby_signing_key_check') observed;
 IF actual IS NULL THEN
  EXECUTE $object$ALTER TABLE public."personal_agent_standby_placements" ADD CONSTRAINT "personal_agent_standby_signing_key_check" CHECK (pod_signing_pubkey ~ '^[A-Za-z0-9+/]{43}=$'::text AND pod_signing_key_id ~ '^pods_[0-9a-f]{32}$'::text);$object$;
 ELSIF encode(sha256(convert_to(actual,'UTF8')),'hex') NOT IN ('cae930f7e4eae2280dbdbcea225aae97056f1701a54d9170a5cf2c34e19e5b37') THEN
  RAISE EXCEPTION 'Unqualified schema drift: personal_agent_standby_signing_key_check';
 END IF;
END
$object_guard$;

DO $object_guard$
DECLARE actual text;
BEGIN
 SELECT definition INTO actual FROM (SELECT pg_get_constraintdef(k.oid,true) definition FROM pg_constraint k WHERE k.conrelid='public.personal_agent_standby_placements'::regclass AND k.conname='personal_agent_standby_sync_check') observed;
 IF actual IS NULL THEN
  EXECUTE $object$ALTER TABLE public."personal_agent_standby_placements" ADD CONSTRAINT "personal_agent_standby_sync_check" CHECK (synced_seq >= 0 AND (synced_seq = 0) = (synced_head_sha IS NULL) AND (synced_head_sha IS NULL OR synced_head_sha ~ '^[0-9a-f]{64}$'::text) AND (last_sync_status = ANY (ARRAY['pending'::text, 'synced'::text, 'failed'::text, 'diverged'::text])));$object$;
 ELSIF encode(sha256(convert_to(actual,'UTF8')),'hex') NOT IN ('154d7c0769a9ada009214473187a93d92233dc476bea0b391d9861dc6e811fb9') THEN
  RAISE EXCEPTION 'Unqualified schema drift: personal_agent_standby_sync_check';
 END IF;
END
$object_guard$;

DO $object_guard$
DECLARE actual text;
BEGIN
 SELECT definition INTO actual FROM (SELECT pg_get_constraintdef(k.oid,true) definition FROM pg_constraint k WHERE k.conrelid='public.personal_agent_standby_placements'::regclass AND k.conname='personal_agent_standby_target_check') observed;
 IF actual IS NULL THEN
  EXECUTE $object$ALTER TABLE public."personal_agent_standby_placements" ADD CONSTRAINT "personal_agent_standby_target_check" CHECK (deployment_target = ANY (ARRAY['gcp'::text, 'user_gcp'::text, 'user_azure'::text]));$object$;
 ELSIF encode(sha256(convert_to(actual,'UTF8')),'hex') NOT IN ('8a930ec9cab2615b8d62a47ddd8041b27223675ebc3ce9c9cb55e6406ffd4dbd') THEN
  RAISE EXCEPTION 'Unqualified schema drift: personal_agent_standby_target_check';
 END IF;
END
$object_guard$;

DO $object_guard$
DECLARE actual text;
BEGIN
 SELECT definition INTO actual FROM (SELECT pg_get_constraintdef(k.oid,true) definition FROM pg_constraint k WHERE k.conrelid='public.personal_agent_standby_placements'::regclass AND k.conname='personal_agent_standby_url_check') observed;
 IF actual IS NULL THEN
  EXECUTE $object$ALTER TABLE public."personal_agent_standby_placements" ADD CONSTRAINT "personal_agent_standby_url_check" CHECK ("left"(url, 8) = 'https://'::text AND length(url) <= 2048);$object$;
 ELSIF encode(sha256(convert_to(actual,'UTF8')),'hex') NOT IN ('0369cb22d08a7858dd5a44338f7d0a6e78ed92d5216bb6d9c9e849c6ca5e0e32') THEN
  RAISE EXCEPTION 'Unqualified schema drift: personal_agent_standby_url_check';
 END IF;
END
$object_guard$;

DO $object_guard$
DECLARE actual text;
BEGIN
 SELECT definition INTO actual FROM (SELECT pg_get_constraintdef(k.oid,true) definition FROM pg_constraint k WHERE k.conrelid='public.personal_agent_standby_placements'::regclass AND k.conname='personal_agent_standby_user_azure_needs_coordinates_check') observed;
 IF actual IS NULL THEN
  EXECUTE $object$ALTER TABLE public."personal_agent_standby_placements" ADD CONSTRAINT "personal_agent_standby_user_azure_needs_coordinates_check" CHECK (deployment_target IS DISTINCT FROM 'user_azure'::text OR user_cloud_tenant_id IS NOT NULL AND user_cloud_subscription_id IS NOT NULL AND user_cloud_resource_group IS NOT NULL AND user_cloud_region IS NOT NULL);$object$;
 ELSIF encode(sha256(convert_to(actual,'UTF8')),'hex') NOT IN ('0d2b7d2ac2d02e6f72e5a01068e07ff77a23c51277e7a9c561391e9d574e031b') THEN
  RAISE EXCEPTION 'Unqualified schema drift: personal_agent_standby_user_azure_needs_coordinates_check';
 END IF;
END
$object_guard$;

DO $object_guard$
DECLARE actual text;
BEGIN
 SELECT definition INTO actual FROM (SELECT pg_get_constraintdef(k.oid,true) definition FROM pg_constraint k WHERE k.conrelid='public.personal_agent_standby_placements'::regclass AND k.conname='personal_agent_standby_user_gcp_needs_project_check') observed;
 IF actual IS NULL THEN
  EXECUTE $object$ALTER TABLE public."personal_agent_standby_placements" ADD CONSTRAINT "personal_agent_standby_user_gcp_needs_project_check" CHECK (deployment_target IS DISTINCT FROM 'user_gcp'::text OR user_cloud_project IS NOT NULL);$object$;
 ELSIF encode(sha256(convert_to(actual,'UTF8')),'hex') NOT IN ('a04b90e94c09d822c72c99ce78dcc2065f81a62d9353487e7fd872bf5db972db') THEN
  RAISE EXCEPTION 'Unqualified schema drift: personal_agent_standby_user_gcp_needs_project_check';
 END IF;
END
$object_guard$;

DO $object_guard$
DECLARE actual text;
BEGIN
 SELECT definition INTO actual FROM (SELECT pg_get_constraintdef(k.oid,true) definition FROM pg_constraint k WHERE k.conrelid='public.pod_lifecycle_events'::regclass AND k.conname='pod_lifecycle_events_pkey') observed;
 IF actual IS NULL THEN
  EXECUTE $object$ALTER TABLE public."pod_lifecycle_events" ADD CONSTRAINT "pod_lifecycle_events_pkey" PRIMARY KEY (user_id, seq);$object$;
 ELSIF encode(sha256(convert_to(actual,'UTF8')),'hex') NOT IN ('d0c5fd912296841ed4b116c926df08c064b47a0502603e1ed74f998b3b496563') THEN
  RAISE EXCEPTION 'Unqualified schema drift: pod_lifecycle_events_pkey';
 END IF;
END
$object_guard$;

DO $object_guard$
DECLARE actual text;
BEGIN
 SELECT definition INTO actual FROM (SELECT pg_get_constraintdef(k.oid,true) definition FROM pg_constraint k WHERE k.conrelid='public.pod_migration_jobs'::regclass AND k.conname='pod_migration_jobs_pkey') observed;
 IF actual IS NULL THEN
  EXECUTE $object$ALTER TABLE public."pod_migration_jobs" ADD CONSTRAINT "pod_migration_jobs_pkey" PRIMARY KEY (user_id);$object$;
 ELSIF encode(sha256(convert_to(actual,'UTF8')),'hex') NOT IN ('44756d887704fc88d8d0adc5c0c431103c555b4f8e6a4ddef6f7a7f6b4110606') THEN
  RAISE EXCEPTION 'Unqualified schema drift: pod_migration_jobs_pkey';
 END IF;
END
$object_guard$;

DO $object_guard$
DECLARE actual text;
BEGIN
 SELECT definition INTO actual FROM (SELECT pg_get_constraintdef(k.oid,true) definition FROM pg_constraint k WHERE k.conrelid='public.pod_request_nonces'::regclass AND k.conname='pod_request_nonces_kid_check') observed;
 IF actual IS NULL THEN
  EXECUTE $object$ALTER TABLE public."pod_request_nonces" ADD CONSTRAINT "pod_request_nonces_kid_check" CHECK (kid ~ '^pods_[0-9a-f]{32}$'::text);$object$;
 ELSIF encode(sha256(convert_to(actual,'UTF8')),'hex') NOT IN ('998c5e6e10c5d58329c6378d9c006a288d31b06b60a7058e9987d9fddf2c1a27') THEN
  RAISE EXCEPTION 'Unqualified schema drift: pod_request_nonces_kid_check';
 END IF;
END
$object_guard$;

DO $object_guard$
DECLARE actual text;
BEGIN
 SELECT definition INTO actual FROM (SELECT pg_get_constraintdef(k.oid,true) definition FROM pg_constraint k WHERE k.conrelid='public.pod_request_nonces'::regclass AND k.conname='pod_request_nonces_nonce_check') observed;
 IF actual IS NULL THEN
  EXECUTE $object$ALTER TABLE public."pod_request_nonces" ADD CONSTRAINT "pod_request_nonces_nonce_check" CHECK (nonce ~ '^[A-Za-z0-9_-]{22}$'::text);$object$;
 ELSIF encode(sha256(convert_to(actual,'UTF8')),'hex') NOT IN ('acb48e48416b3ce7b8924d2654abb220d2ff1a768a1e9d509eaec778b78ed40a') THEN
  RAISE EXCEPTION 'Unqualified schema drift: pod_request_nonces_nonce_check';
 END IF;
END
$object_guard$;

DO $object_guard$
DECLARE actual text;
BEGIN
 SELECT definition INTO actual FROM (SELECT pg_get_constraintdef(k.oid,true) definition FROM pg_constraint k WHERE k.conrelid='public.pod_request_nonces'::regclass AND k.conname='pod_request_nonces_pkey') observed;
 IF actual IS NULL THEN
  EXECUTE $object$ALTER TABLE public."pod_request_nonces" ADD CONSTRAINT "pod_request_nonces_pkey" PRIMARY KEY (kid, nonce);$object$;
 ELSIF encode(sha256(convert_to(actual,'UTF8')),'hex') NOT IN ('ca360e9ea00e613a85cd6c604fe9d12fcc8b7d00256d382bf51bae41b671bea6') THEN
  RAISE EXCEPTION 'Unqualified schema drift: pod_request_nonces_pkey';
 END IF;
END
$object_guard$;

DO $object_guard$
DECLARE actual text;
BEGIN
 SELECT definition INTO actual FROM (SELECT pg_get_constraintdef(k.oid,true) definition FROM pg_constraint k WHERE k.conrelid='public.shared_files_storage'::regclass AND k.conname='shared_files_storage_bucket_admission_check') observed;
 IF actual IS NULL THEN
  EXECUTE $object$ALTER TABLE public."shared_files_storage" ADD CONSTRAINT "shared_files_storage_bucket_admission_check" CHECK (bucket_admission IS NULL OR jsonb_typeof(bucket_admission) = 'object'::text);$object$;
 ELSIF encode(sha256(convert_to(actual,'UTF8')),'hex') NOT IN ('412d40554de9d97537dfe5a47a2765169c9e2cc78413904aefad4fec45ba7c7c') THEN
  RAISE EXCEPTION 'Unqualified schema drift: shared_files_storage_bucket_admission_check';
 END IF;
END
$object_guard$;

DO $object_guard$
DECLARE actual text;
BEGIN
 SELECT definition INTO actual FROM (SELECT pg_get_constraintdef(k.oid,true) definition FROM pg_constraint k WHERE k.conrelid='public.shared_files_storage'::regclass AND k.conname='shared_files_storage_pkey') observed;
 IF actual IS NULL THEN
  EXECUTE $object$ALTER TABLE public."shared_files_storage" ADD CONSTRAINT "shared_files_storage_pkey" PRIMARY KEY (user_id);$object$;
 ELSIF encode(sha256(convert_to(actual,'UTF8')),'hex') NOT IN ('44756d887704fc88d8d0adc5c0c431103c555b4f8e6a4ddef6f7a7f6b4110606') THEN
  RAISE EXCEPTION 'Unqualified schema drift: shared_files_storage_pkey';
 END IF;
END
$object_guard$;

DO $object_guard$
DECLARE actual text;
BEGIN
 SELECT definition INTO actual FROM (SELECT pg_get_constraintdef(k.oid,true) definition FROM pg_constraint k WHERE k.conrelid='public.shared_files_storage'::regclass AND k.conname='shared_files_storage_state_check') observed;
 IF actual IS NULL THEN
  EXECUTE $object$ALTER TABLE public."shared_files_storage" ADD CONSTRAINT "shared_files_storage_state_check" CHECK (state = ANY (ARRAY['active'::text, 'erasing'::text, 'erased'::text]));$object$;
 ELSIF encode(sha256(convert_to(actual,'UTF8')),'hex') NOT IN ('cc508223c1dd8851546fbced1adb074f261f2f3c61de4bc371824bb5a0d278b4') THEN
  RAISE EXCEPTION 'Unqualified schema drift: shared_files_storage_state_check';
 END IF;
END
$object_guard$;

DO $object_guard$
DECLARE actual text;
BEGIN
 SELECT definition INTO actual FROM (SELECT pg_get_constraintdef(k.oid,true) definition FROM pg_constraint k WHERE k.conrelid='public.shared_files_storage'::regclass AND k.conname='shared_files_storage_writes_check') observed;
 IF actual IS NULL THEN
  EXECUTE $object$ALTER TABLE public."shared_files_storage" ADD CONSTRAINT "shared_files_storage_writes_check" CHECK (jsonb_typeof(writes) = 'object'::text);$object$;
 ELSIF encode(sha256(convert_to(actual,'UTF8')),'hex') NOT IN ('81164e6171b8ac074db081078e043602a6d9da03f0140427c87f1df561f39195') THEN
  RAISE EXCEPTION 'Unqualified schema drift: shared_files_storage_writes_check';
 END IF;
END
$object_guard$;

DO $object_guard$
DECLARE actual text;
BEGIN
 SELECT definition INTO actual FROM (SELECT pg_get_constraintdef(k.oid,true) definition FROM pg_constraint k WHERE k.conrelid='public.webauthn_challenges'::regclass AND k.conname='webauthn_challenges_pkey') observed;
 IF actual IS NULL THEN
  EXECUTE $object$ALTER TABLE public."webauthn_challenges" ADD CONSTRAINT "webauthn_challenges_pkey" PRIMARY KEY (id);$object$;
 ELSIF encode(sha256(convert_to(actual,'UTF8')),'hex') NOT IN ('8c8464f42472e42ee190fc91ca8db79b5351d3a4609040516578d229c56f6fa5') THEN
  RAISE EXCEPTION 'Unqualified schema drift: webauthn_challenges_pkey';
 END IF;
END
$object_guard$;

DO $object_guard$
DECLARE actual text;
BEGIN
 SELECT definition INTO actual FROM (SELECT pg_get_constraintdef(k.oid,true) definition FROM pg_constraint k WHERE k.conrelid='public.webauthn_credentials'::regclass AND k.conname='webauthn_credentials_credential_id_key') observed;
 IF actual IS NULL THEN
  EXECUTE $object$ALTER TABLE public."webauthn_credentials" ADD CONSTRAINT "webauthn_credentials_credential_id_key" UNIQUE (credential_id);$object$;
 ELSIF encode(sha256(convert_to(actual,'UTF8')),'hex') NOT IN ('1e58a89ac5da19236a54c898ad01ea37cdd8c17fb9dd6dfd3ee8306acbd39a78') THEN
  RAISE EXCEPTION 'Unqualified schema drift: webauthn_credentials_credential_id_key';
 END IF;
END
$object_guard$;

DO $object_guard$
DECLARE actual text;
BEGIN
 SELECT definition INTO actual FROM (SELECT pg_get_constraintdef(k.oid,true) definition FROM pg_constraint k WHERE k.conrelid='public.webauthn_credentials'::regclass AND k.conname='webauthn_credentials_pkey') observed;
 IF actual IS NULL THEN
  EXECUTE $object$ALTER TABLE public."webauthn_credentials" ADD CONSTRAINT "webauthn_credentials_pkey" PRIMARY KEY (id);$object$;
 ELSIF encode(sha256(convert_to(actual,'UTF8')),'hex') NOT IN ('8c8464f42472e42ee190fc91ca8db79b5351d3a4609040516578d229c56f6fa5') THEN
  RAISE EXCEPTION 'Unqualified schema drift: webauthn_credentials_pkey';
 END IF;
END
$object_guard$;

DO $object_guard$
DECLARE actual text;
BEGIN
 SELECT definition INTO actual FROM (SELECT pg_get_constraintdef(k.oid,true) definition FROM pg_constraint k WHERE k.conrelid='public.personal_agent_standby_placements'::regclass AND k.conname='personal_agent_standby_placements_hushh_id_fkey') observed;
 IF actual IS NULL THEN
  EXECUTE $object$ALTER TABLE public."personal_agent_standby_placements" ADD CONSTRAINT "personal_agent_standby_placements_hushh_id_fkey" FOREIGN KEY (hushh_id) REFERENCES personal_agent_registry(hushh_id) ON DELETE RESTRICT;$object$;
 ELSIF encode(sha256(convert_to(actual,'UTF8')),'hex') NOT IN ('9225aa07f0a14fa64a30e93c7b6576077b409a5e19d6f7774664b6dc67260f04') THEN
  RAISE EXCEPTION 'Unqualified schema drift: personal_agent_standby_placements_hushh_id_fkey';
 END IF;
END
$object_guard$;

DO $object_guard$
DECLARE actual text;
BEGIN
 SELECT definition INTO actual FROM (SELECT pg_get_constraintdef(k.oid,true) definition FROM pg_constraint k WHERE k.conrelid='public.personal_agent_standby_placements'::regclass AND k.conname='personal_agent_standby_placements_user_id_fkey') observed;
 IF actual IS NULL THEN
  EXECUTE $object$ALTER TABLE public."personal_agent_standby_placements" ADD CONSTRAINT "personal_agent_standby_placements_user_id_fkey" FOREIGN KEY (user_id) REFERENCES personal_agent_registry(user_id) ON DELETE RESTRICT;$object$;
 ELSIF encode(sha256(convert_to(actual,'UTF8')),'hex') NOT IN ('41b61dd3d6bd9d7040b19e9249f7284ff1e5bb10be45a2e93e6495bb4aa45c39') THEN
  RAISE EXCEPTION 'Unqualified schema drift: personal_agent_standby_placements_user_id_fkey';
 END IF;
END
$object_guard$;

DO $object_guard$
DECLARE actual text;
BEGIN
 SELECT definition INTO actual FROM (SELECT pg_get_constraintdef(k.oid,true) definition FROM pg_constraint k WHERE k.conrelid='public.shared_files_storage'::regclass AND k.conname='shared_files_storage_user_id_fkey') observed;
 IF actual IS NULL THEN
  EXECUTE $object$ALTER TABLE public."shared_files_storage" ADD CONSTRAINT "shared_files_storage_user_id_fkey" FOREIGN KEY (user_id) REFERENCES vault_keys(user_id) ON DELETE RESTRICT;$object$;
 ELSIF encode(sha256(convert_to(actual,'UTF8')),'hex') NOT IN ('f629e2d564d318f34abcd0f8d74dd67d4082b833ea580c50c44d819240d0521b') THEN
  RAISE EXCEPTION 'Unqualified schema drift: shared_files_storage_user_id_fkey';
 END IF;
END
$object_guard$;

DO $object_guard$
DECLARE actual text;
BEGIN
 SELECT definition INTO actual FROM (SELECT pg_get_triggerdef(t.oid,true) definition FROM pg_trigger t WHERE t.tgrelid='public.account_deletion_tombstones'::regclass AND t.tgname='zv_azure_vm_power') observed;
 IF actual IS NULL THEN
  EXECUTE $object$CREATE TRIGGER zv_azure_vm_power BEFORE INSERT OR DELETE OR UPDATE ON account_deletion_tombstones FOR EACH ROW EXECUTE FUNCTION guard_azure_vm_power_deletion();$object$;
 ELSIF encode(sha256(convert_to(actual,'UTF8')),'hex') NOT IN ('2b528c78d06c7760d805d9222c94840eb8e135290be9d2705303ab08c8591f59') THEN
  RAISE EXCEPTION 'Unqualified schema drift: zv_azure_vm_power';
 END IF;
END
$object_guard$;

DO $pod_414$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.account_deletion_tombstones'::regclass AND tgname='zv_azure_vm_power' AND tgenabled='O') THEN RAISE EXCEPTION 'Unqualified trigger state: zv_azure_vm_power'; END IF;
END
$pod_414$;

DO $object_guard$
DECLARE actual text;
BEGIN
 SELECT definition INTO actual FROM (SELECT pg_get_triggerdef(t.oid,true) definition FROM pg_trigger t WHERE t.tgrelid='public.byoc_setup_jobs'::regclass AND t.tgname='zv_azure_vm_power') observed;
 IF actual IS NULL THEN
  EXECUTE $object$CREATE TRIGGER zv_azure_vm_power BEFORE INSERT OR DELETE OR UPDATE ON byoc_setup_jobs FOR EACH ROW EXECUTE FUNCTION guard_azure_vm_power_standby();$object$;
 ELSIF encode(sha256(convert_to(actual,'UTF8')),'hex') NOT IN ('93b036baaf3e5509c306a5812feaa9000d692bef89058d6fc9cea15f02fd32a8') THEN
  RAISE EXCEPTION 'Unqualified schema drift: zv_azure_vm_power';
 END IF;
END
$object_guard$;

DO $pod_414$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.byoc_setup_jobs'::regclass AND tgname='zv_azure_vm_power' AND tgenabled='O') THEN RAISE EXCEPTION 'Unqualified trigger state: zv_azure_vm_power'; END IF;
END
$pod_414$;

DO $object_guard$
DECLARE actual text;
BEGIN
 SELECT definition INTO actual FROM (SELECT pg_get_triggerdef(t.oid,true) definition FROM pg_trigger t WHERE t.tgrelid='public.byoc_setup_jobs'::regclass AND t.tgname='zw_byoc_azure_erasure') observed;
 IF actual IS NULL THEN
  EXECUTE $object$CREATE TRIGGER zw_byoc_azure_erasure BEFORE INSERT OR DELETE OR UPDATE ON byoc_setup_jobs FOR EACH ROW EXECUTE FUNCTION guard_byoc_azure_erasure_job();$object$;
 ELSIF encode(sha256(convert_to(actual,'UTF8')),'hex') NOT IN ('88aa2a32834d66e60a737764e89d4123c51337cdcdac6cab5c87f5e50f1e7c02') THEN
  RAISE EXCEPTION 'Unqualified schema drift: zw_byoc_azure_erasure';
 END IF;
END
$object_guard$;

DO $pod_414$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.byoc_setup_jobs'::regclass AND tgname='zw_byoc_azure_erasure' AND tgenabled='O') THEN RAISE EXCEPTION 'Unqualified trigger state: zw_byoc_azure_erasure'; END IF;
END
$pod_414$;

DO $object_guard$
DECLARE actual text;
BEGIN
 SELECT definition INTO actual FROM (SELECT pg_get_triggerdef(t.oid,true) definition FROM pg_trigger t WHERE t.tgrelid='public.byoc_setup_jobs'::regclass AND t.tgname='zx_project_grant_setup') observed;
 IF actual IS NULL THEN
  EXECUTE $object$CREATE TRIGGER zx_project_grant_setup BEFORE INSERT OR UPDATE ON byoc_setup_jobs FOR EACH ROW EXECUTE FUNCTION guard_project_grant_setup_admission();$object$;
 ELSIF encode(sha256(convert_to(actual,'UTF8')),'hex') NOT IN ('aa4643f9694d8bdb877e3ad7a74fbd9b5a95232889b1520a79bf5d6450078d7c') THEN
  RAISE EXCEPTION 'Unqualified schema drift: zx_project_grant_setup';
 END IF;
END
$object_guard$;

DO $pod_414$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.byoc_setup_jobs'::regclass AND tgname='zx_project_grant_setup' AND tgenabled='O') THEN RAISE EXCEPTION 'Unqualified trigger state: zx_project_grant_setup'; END IF;
END
$pod_414$;

DO $object_guard$
DECLARE actual text;
BEGIN
 SELECT definition INTO actual FROM (SELECT pg_get_triggerdef(t.oid,true) definition FROM pg_trigger t WHERE t.tgrelid='public.byoc_setup_jobs'::regclass AND t.tgname='zz_byoc_authorization_attempts') observed;
 IF actual IS NULL THEN
  EXECUTE $object$CREATE TRIGGER zz_byoc_authorization_attempts BEFORE INSERT OR DELETE OR UPDATE ON byoc_setup_jobs FOR EACH ROW EXECUTE FUNCTION guard_byoc_authorization_attempts();$object$;
 ELSIF encode(sha256(convert_to(actual,'UTF8')),'hex') NOT IN ('8ecd00d9127b7fc628079ff7bad55e74294f7236e8a5aa71bed821986622e7c9') THEN
  RAISE EXCEPTION 'Unqualified schema drift: zz_byoc_authorization_attempts';
 END IF;
END
$object_guard$;

DO $pod_414$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.byoc_setup_jobs'::regclass AND tgname='zz_byoc_authorization_attempts' AND tgenabled='O') THEN RAISE EXCEPTION 'Unqualified trigger state: zz_byoc_authorization_attempts'; END IF;
END
$pod_414$;

DO $object_guard$
DECLARE actual text;
BEGIN
 SELECT definition INTO actual FROM (SELECT pg_get_triggerdef(t.oid,true) definition FROM pg_trigger t WHERE t.tgrelid='public.consent_audit'::regclass AND t.tgname='zy_personal_agent_erasure_grant') observed;
 IF actual IS NULL THEN
  EXECUTE $object$CREATE TRIGGER zy_personal_agent_erasure_grant BEFORE INSERT ON consent_audit FOR EACH ROW EXECUTE FUNCTION guard_personal_agent_erasure_grant();$object$;
 ELSIF encode(sha256(convert_to(actual,'UTF8')),'hex') NOT IN ('22968fd67be54af44297bcf102b58b1ca14c5b93d1911679a38925abb982e111') THEN
  RAISE EXCEPTION 'Unqualified schema drift: zy_personal_agent_erasure_grant';
 END IF;
END
$object_guard$;

DO $pod_414$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.consent_audit'::regclass AND tgname='zy_personal_agent_erasure_grant' AND tgenabled='O') THEN RAISE EXCEPTION 'Unqualified trigger state: zy_personal_agent_erasure_grant'; END IF;
END
$pod_414$;

DO $object_guard$
DECLARE actual text;
BEGIN
 SELECT definition INTO actual FROM (SELECT pg_get_triggerdef(t.oid,true) definition FROM pg_trigger t WHERE t.tgrelid='public.consent_audit'::regclass AND t.tgname='zz_personal_agent_renewal_authority') observed;
 IF actual IS NULL THEN
  EXECUTE $object$CREATE TRIGGER zz_personal_agent_renewal_authority BEFORE INSERT ON consent_audit FOR EACH ROW EXECUTE FUNCTION guard_personal_agent_renewal();$object$;
 ELSIF encode(sha256(convert_to(actual,'UTF8')),'hex') NOT IN ('1887d7e8d6dff20fe3ef9497bf00a99f1399a258ecd49e456483534cbf90aa6c') THEN
  RAISE EXCEPTION 'Unqualified schema drift: zz_personal_agent_renewal_authority';
 END IF;
END
$object_guard$;

DO $pod_414$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.consent_audit'::regclass AND tgname='zz_personal_agent_renewal_authority' AND tgenabled='O') THEN RAISE EXCEPTION 'Unqualified trigger state: zz_personal_agent_renewal_authority'; END IF;
END
$pod_414$;

DO $object_guard$
DECLARE actual text;
BEGIN
 SELECT definition INTO actual FROM (SELECT pg_get_triggerdef(t.oid,true) definition FROM pg_trigger t WHERE t.tgrelid='public.consent_audit_receipts'::regclass AND t.tgname='account_retired_generation_update') observed;
 IF actual IS NULL THEN
  EXECUTE $object$CREATE TRIGGER account_retired_generation_update BEFORE UPDATE ON consent_audit_receipts FOR EACH ROW EXECUTE FUNCTION reject_retired_account_update('subject_id');$object$;
 ELSIF encode(sha256(convert_to(actual,'UTF8')),'hex') NOT IN ('b6a636f3ef25f2bf96a12289034c985fc400171a3cdcead3cdf3e0abd26721d8') THEN
  RAISE EXCEPTION 'Unqualified schema drift: account_retired_generation_update';
 END IF;
END
$object_guard$;

DO $pod_414$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.consent_audit_receipts'::regclass AND tgname='account_retired_generation_update' AND tgenabled='O') THEN RAISE EXCEPTION 'Unqualified trigger state: account_retired_generation_update'; END IF;
END
$pod_414$;

DO $object_guard$
DECLARE actual text;
BEGIN
 SELECT definition INTO actual FROM (SELECT pg_get_triggerdef(t.oid,true) definition FROM pg_trigger t WHERE t.tgrelid='public.consent_audit_receipts'::regclass AND t.tgname='trg_reject_deleted_account_insert') observed;
 IF actual IS NULL THEN
  EXECUTE $object$CREATE TRIGGER trg_reject_deleted_account_insert BEFORE INSERT ON consent_audit_receipts FOR EACH ROW EXECUTE FUNCTION reject_deleted_account_identity_write('subject_id');$object$;
 ELSIF encode(sha256(convert_to(actual,'UTF8')),'hex') NOT IN ('87a083b266775650232ed7cb751e5e3d22e8455da8dff11b3160facc570dc205') THEN
  RAISE EXCEPTION 'Unqualified schema drift: trg_reject_deleted_account_insert';
 END IF;
END
$object_guard$;

DO $pod_414$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.consent_audit_receipts'::regclass AND tgname='trg_reject_deleted_account_insert' AND tgenabled='O') THEN RAISE EXCEPTION 'Unqualified trigger state: trg_reject_deleted_account_insert'; END IF;
END
$pod_414$;

DO $object_guard$
DECLARE actual text;
BEGIN
 SELECT definition INTO actual FROM (SELECT pg_get_triggerdef(t.oid,true) definition FROM pg_trigger t WHERE t.tgrelid='public.consent_audit_receipts'::regclass AND t.tgname='trg_reject_deleted_account_reference_update') observed;
 IF actual IS NULL THEN
  EXECUTE $object$CREATE TRIGGER trg_reject_deleted_account_reference_update BEFORE UPDATE OF subject_id ON consent_audit_receipts FOR EACH ROW EXECUTE FUNCTION reject_deleted_account_identity_write('subject_id');$object$;
 ELSIF encode(sha256(convert_to(actual,'UTF8')),'hex') NOT IN ('75ff0a362a45259ebc2b86a363dd48de0a4759fa6922989ed00c45b801d65823') THEN
  RAISE EXCEPTION 'Unqualified schema drift: trg_reject_deleted_account_reference_update';
 END IF;
END
$object_guard$;

DO $pod_414$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.consent_audit_receipts'::regclass AND tgname='trg_reject_deleted_account_reference_update' AND tgenabled='O') THEN RAISE EXCEPTION 'Unqualified trigger state: trg_reject_deleted_account_reference_update'; END IF;
END
$pod_414$;

DO $object_guard$
DECLARE actual text;
BEGIN
 SELECT definition INTO actual FROM (SELECT pg_get_triggerdef(t.oid,true) definition FROM pg_trigger t WHERE t.tgrelid='public.personal_agent_cloud_removals'::regclass AND t.tgname='account_retired_generation_update') observed;
 IF actual IS NULL THEN
  EXECUTE $object$CREATE TRIGGER account_retired_generation_update BEFORE UPDATE ON personal_agent_cloud_removals FOR EACH ROW EXECUTE FUNCTION reject_retired_account_update('user_id');$object$;
 ELSIF encode(sha256(convert_to(actual,'UTF8')),'hex') NOT IN ('778a903077dd4e36cc7f7da04fe515aad03ce24294759c6bbf9c004fbb1c236b') THEN
  RAISE EXCEPTION 'Unqualified schema drift: account_retired_generation_update';
 END IF;
END
$object_guard$;

DO $pod_414$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.personal_agent_cloud_removals'::regclass AND tgname='account_retired_generation_update' AND tgenabled='O') THEN RAISE EXCEPTION 'Unqualified trigger state: account_retired_generation_update'; END IF;
END
$pod_414$;

DO $object_guard$
DECLARE actual text;
BEGIN
 SELECT definition INTO actual FROM (SELECT pg_get_triggerdef(t.oid,true) definition FROM pg_trigger t WHERE t.tgrelid='public.personal_agent_cloud_removals'::regclass AND t.tgname='trg_reject_deleted_account_insert') observed;
 IF actual IS NULL THEN
  EXECUTE $object$CREATE TRIGGER trg_reject_deleted_account_insert BEFORE INSERT ON personal_agent_cloud_removals FOR EACH ROW EXECUTE FUNCTION reject_deleted_account_identity_write('user_id');$object$;
 ELSIF encode(sha256(convert_to(actual,'UTF8')),'hex') NOT IN ('b0e4a82288b98e91f1b9bd3f387ba8da140b51f656a150cf8ac9eb129edbbed3') THEN
  RAISE EXCEPTION 'Unqualified schema drift: trg_reject_deleted_account_insert';
 END IF;
END
$object_guard$;

DO $pod_414$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.personal_agent_cloud_removals'::regclass AND tgname='trg_reject_deleted_account_insert' AND tgenabled='O') THEN RAISE EXCEPTION 'Unqualified trigger state: trg_reject_deleted_account_insert'; END IF;
END
$pod_414$;

DO $object_guard$
DECLARE actual text;
BEGIN
 SELECT definition INTO actual FROM (SELECT pg_get_triggerdef(t.oid,true) definition FROM pg_trigger t WHERE t.tgrelid='public.personal_agent_cloud_removals'::regclass AND t.tgname='trg_reject_deleted_account_reference_update') observed;
 IF actual IS NULL THEN
  EXECUTE $object$CREATE TRIGGER trg_reject_deleted_account_reference_update BEFORE UPDATE OF user_id ON personal_agent_cloud_removals FOR EACH ROW EXECUTE FUNCTION reject_deleted_account_identity_write('user_id');$object$;
 ELSIF encode(sha256(convert_to(actual,'UTF8')),'hex') NOT IN ('287d17229f91aa2c9c406cad281e43fa2f938f009150c7e96beb469532333fcc') THEN
  RAISE EXCEPTION 'Unqualified schema drift: trg_reject_deleted_account_reference_update';
 END IF;
END
$object_guard$;

DO $pod_414$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.personal_agent_cloud_removals'::regclass AND tgname='trg_reject_deleted_account_reference_update' AND tgenabled='O') THEN RAISE EXCEPTION 'Unqualified trigger state: trg_reject_deleted_account_reference_update'; END IF;
END
$pod_414$;

DO $object_guard$
DECLARE actual text;
BEGIN
 SELECT definition INTO actual FROM (SELECT pg_get_triggerdef(t.oid,true) definition FROM pg_trigger t WHERE t.tgrelid='public.personal_agent_cloud_removals'::regclass AND t.tgname='zz_personal_agent_cloud_removal') observed;
 IF actual IS NULL THEN
  EXECUTE $object$CREATE TRIGGER zz_personal_agent_cloud_removal BEFORE INSERT OR DELETE OR UPDATE ON personal_agent_cloud_removals FOR EACH ROW EXECUTE FUNCTION guard_personal_agent_cloud_removal();$object$;
 ELSIF encode(sha256(convert_to(actual,'UTF8')),'hex') NOT IN ('855fc369a93e2442ce68fb6409f0f32e9e60534bc08d243ad94dc7a29e539d86') THEN
  RAISE EXCEPTION 'Unqualified schema drift: zz_personal_agent_cloud_removal';
 END IF;
END
$object_guard$;

DO $pod_414$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.personal_agent_cloud_removals'::regclass AND tgname='zz_personal_agent_cloud_removal' AND tgenabled='O') THEN RAISE EXCEPTION 'Unqualified trigger state: zz_personal_agent_cloud_removal'; END IF;
END
$pod_414$;

DO $object_guard$
DECLARE actual text;
BEGIN
 SELECT definition INTO actual FROM (SELECT pg_get_triggerdef(t.oid,true) definition FROM pg_trigger t WHERE t.tgrelid='public.personal_agent_cloud_removals'::regclass AND t.tgname='zz_personal_agent_cloud_removal_history') observed;
 IF actual IS NULL THEN
  EXECUTE $object$CREATE TRIGGER zz_personal_agent_cloud_removal_history AFTER INSERT OR UPDATE ON personal_agent_cloud_removals FOR EACH ROW EXECUTE FUNCTION guard_personal_agent_cloud_removal_history();$object$;
 ELSIF encode(sha256(convert_to(actual,'UTF8')),'hex') NOT IN ('3acba171090fa9a45dd444e068810363b8d6b15f711eeb8eb896868e87685516') THEN
  RAISE EXCEPTION 'Unqualified schema drift: zz_personal_agent_cloud_removal_history';
 END IF;
END
$object_guard$;

DO $pod_414$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.personal_agent_cloud_removals'::regclass AND tgname='zz_personal_agent_cloud_removal_history' AND tgenabled='O') THEN RAISE EXCEPTION 'Unqualified trigger state: zz_personal_agent_cloud_removal_history'; END IF;
END
$pod_414$;

DO $object_guard$
DECLARE actual text;
BEGIN
 SELECT definition INTO actual FROM (SELECT pg_get_triggerdef(t.oid,true) definition FROM pg_trigger t WHERE t.tgrelid='public.personal_agent_deletion_tombstones'::regclass AND t.tgname='zv_azure_vm_power') observed;
 IF actual IS NULL THEN
  EXECUTE $object$CREATE TRIGGER zv_azure_vm_power BEFORE INSERT OR DELETE OR UPDATE ON personal_agent_deletion_tombstones FOR EACH ROW EXECUTE FUNCTION guard_azure_vm_power_deletion();$object$;
 ELSIF encode(sha256(convert_to(actual,'UTF8')),'hex') NOT IN ('e8a76b478175c7e26885fc5a5bde5c7a27999a13063ddc78b69e18e72372e5fe') THEN
  RAISE EXCEPTION 'Unqualified schema drift: zv_azure_vm_power';
 END IF;
END
$object_guard$;

DO $pod_414$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.personal_agent_deletion_tombstones'::regclass AND tgname='zv_azure_vm_power' AND tgenabled='O') THEN RAISE EXCEPTION 'Unqualified trigger state: zv_azure_vm_power'; END IF;
END
$pod_414$;

DO $object_guard$
DECLARE actual text;
BEGIN
 SELECT definition INTO actual FROM (SELECT pg_get_triggerdef(t.oid,true) definition FROM pg_trigger t WHERE t.tgrelid='public.personal_agent_deletion_tombstones'::regclass AND t.tgname='zz_personal_agent_erasure_archive') observed;
 IF actual IS NULL THEN
  EXECUTE $object$CREATE TRIGGER zz_personal_agent_erasure_archive BEFORE INSERT OR DELETE OR UPDATE ON personal_agent_deletion_tombstones FOR EACH ROW EXECUTE FUNCTION guard_personal_agent_erasure_archive();$object$;
 ELSIF encode(sha256(convert_to(actual,'UTF8')),'hex') NOT IN ('22e516b72a373f1b49f8059d2fffc9e499140ab94a75cc3e9a430da25ba70b46') THEN
  RAISE EXCEPTION 'Unqualified schema drift: zz_personal_agent_erasure_archive';
 END IF;
END
$object_guard$;

DO $pod_414$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.personal_agent_deletion_tombstones'::regclass AND tgname='zz_personal_agent_erasure_archive' AND tgenabled='O') THEN RAISE EXCEPTION 'Unqualified trigger state: zz_personal_agent_erasure_archive'; END IF;
END
$pod_414$;

DO $object_guard$
DECLARE actual text;
BEGIN
 SELECT definition INTO actual FROM (SELECT pg_get_triggerdef(t.oid,true) definition FROM pg_trigger t WHERE t.tgrelid='public.personal_agent_registry'::regclass AND t.tgname='zw_azure_vm_power') observed;
 IF actual IS NULL THEN
  EXECUTE $object$CREATE TRIGGER zw_azure_vm_power BEFORE INSERT OR DELETE OR UPDATE ON personal_agent_registry FOR EACH ROW EXECUTE FUNCTION guard_azure_vm_power_registry();$object$;
 ELSIF encode(sha256(convert_to(actual,'UTF8')),'hex') NOT IN ('d4cb3b7a75d395ae2183b32ab63cdc00c345d216fa84445ec38e051c5a1bc5b4') THEN
  RAISE EXCEPTION 'Unqualified schema drift: zw_azure_vm_power';
 END IF;
END
$object_guard$;

DO $pod_414$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.personal_agent_registry'::regclass AND tgname='zw_azure_vm_power' AND tgenabled='O') THEN RAISE EXCEPTION 'Unqualified trigger state: zw_azure_vm_power'; END IF;
END
$pod_414$;

DO $object_guard$
DECLARE actual text;
BEGIN
 SELECT definition INTO actual FROM (SELECT pg_get_triggerdef(t.oid,true) definition FROM pg_trigger t WHERE t.tgrelid='public.personal_agent_registry'::regclass AND t.tgname='zx_personal_agent_notification_registry') observed;
 IF actual IS NULL THEN
  EXECUTE $object$CREATE TRIGGER zx_personal_agent_notification_registry BEFORE UPDATE ON personal_agent_registry FOR EACH ROW EXECUTE FUNCTION guard_personal_agent_notification_registry();$object$;
 ELSIF encode(sha256(convert_to(actual,'UTF8')),'hex') NOT IN ('edf6667a373e2cf0e457f4acd252418554c683312f1706588bc0f72d269f491d') THEN
  RAISE EXCEPTION 'Unqualified schema drift: zx_personal_agent_notification_registry';
 END IF;
END
$object_guard$;

DO $pod_414$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.personal_agent_registry'::regclass AND tgname='zx_personal_agent_notification_registry' AND tgenabled='O') THEN RAISE EXCEPTION 'Unqualified trigger state: zx_personal_agent_notification_registry'; END IF;
END
$pod_414$;

DO $object_guard$
DECLARE actual text;
BEGIN
 SELECT definition INTO actual FROM (SELECT pg_get_triggerdef(t.oid,true) definition FROM pg_trigger t WHERE t.tgrelid='public.personal_agent_registry'::regclass AND t.tgname='zx_project_grant_registry') observed;
 IF actual IS NULL THEN
  EXECUTE $object$CREATE TRIGGER zx_project_grant_registry BEFORE INSERT OR UPDATE ON personal_agent_registry FOR EACH ROW EXECUTE FUNCTION guard_project_grant_registry_admission();$object$;
 ELSIF encode(sha256(convert_to(actual,'UTF8')),'hex') NOT IN ('97497b99a3ff0971b2d6facdf88e2385e913e2b6da3abcf752557c17befdbd21') THEN
  RAISE EXCEPTION 'Unqualified schema drift: zx_project_grant_registry';
 END IF;
END
$object_guard$;

DO $pod_414$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.personal_agent_registry'::regclass AND tgname='zx_project_grant_registry' AND tgenabled='O') THEN RAISE EXCEPTION 'Unqualified trigger state: zx_project_grant_registry'; END IF;
END
$pod_414$;

DO $object_guard$
DECLARE actual text;
BEGIN
 SELECT definition INTO actual FROM (SELECT pg_get_triggerdef(t.oid,true) definition FROM pg_trigger t WHERE t.tgrelid='public.personal_agent_registry'::regclass AND t.tgname='zy_personal_agent_provision_registry') observed;
 IF actual IS NULL THEN
  EXECUTE $object$CREATE TRIGGER zy_personal_agent_provision_registry BEFORE DELETE OR UPDATE ON personal_agent_registry FOR EACH ROW EXECUTE FUNCTION guard_personal_agent_provision_registry();$object$;
 ELSIF encode(sha256(convert_to(actual,'UTF8')),'hex') NOT IN ('67ac677b824410771ea0d2e74179a185ee818ed1582d0816a58bd58f2ce66377') THEN
  RAISE EXCEPTION 'Unqualified schema drift: zy_personal_agent_provision_registry';
 END IF;
END
$object_guard$;

DO $pod_414$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.personal_agent_registry'::regclass AND tgname='zy_personal_agent_provision_registry' AND tgenabled='O') THEN RAISE EXCEPTION 'Unqualified trigger state: zy_personal_agent_provision_registry'; END IF;
END
$pod_414$;

DO $object_guard$
DECLARE actual text;
BEGIN
 SELECT definition INTO actual FROM (SELECT pg_get_triggerdef(t.oid,true) definition FROM pg_trigger t WHERE t.tgrelid='public.personal_agent_registry'::regclass AND t.tgname='zz_personal_agent_erasure_registry') observed;
 IF actual IS NULL THEN
  EXECUTE $object$CREATE TRIGGER zz_personal_agent_erasure_registry BEFORE DELETE OR UPDATE ON personal_agent_registry FOR EACH ROW EXECUTE FUNCTION guard_personal_agent_erasure_registry();$object$;
 ELSIF encode(sha256(convert_to(actual,'UTF8')),'hex') NOT IN ('4812dbadfde3e0f4682839f476fedf4b53814e14cfc90f4442a870946f66a573') THEN
  RAISE EXCEPTION 'Unqualified schema drift: zz_personal_agent_erasure_registry';
 END IF;
END
$object_guard$;

DO $pod_414$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.personal_agent_registry'::regclass AND tgname='zz_personal_agent_erasure_registry' AND tgenabled='O') THEN RAISE EXCEPTION 'Unqualified trigger state: zz_personal_agent_erasure_registry'; END IF;
END
$pod_414$;

DO $object_guard$
DECLARE actual text;
BEGIN
 SELECT definition INTO actual FROM (SELECT pg_get_triggerdef(t.oid,true) definition FROM pg_trigger t WHERE t.tgrelid='public.personal_agent_registry'::regclass AND t.tgname='zz_personal_agent_notification_retention') observed;
 IF actual IS NULL THEN
  EXECUTE $object$CREATE CONSTRAINT TRIGGER zz_personal_agent_notification_retention AFTER DELETE OR UPDATE ON personal_agent_registry DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION guard_personal_agent_notification_retention();$object$;
 ELSIF encode(sha256(convert_to(actual,'UTF8')),'hex') NOT IN ('c6031c86f1e9a7a0df83bffc435aa61ce36a83f62565dba12df76d56346df571') THEN
  RAISE EXCEPTION 'Unqualified schema drift: zz_personal_agent_notification_retention';
 END IF;
END
$object_guard$;

DO $pod_414$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.personal_agent_registry'::regclass AND tgname='zz_personal_agent_notification_retention' AND tgenabled='O') THEN RAISE EXCEPTION 'Unqualified trigger state: zz_personal_agent_notification_retention'; END IF;
END
$pod_414$;

DO $object_guard$
DECLARE actual text;
BEGIN
 SELECT definition INTO actual FROM (SELECT pg_get_triggerdef(t.oid,true) definition FROM pg_trigger t WHERE t.tgrelid='public.personal_agent_registry'::regclass AND t.tgname='zzz_pod_signing_key_follows_pod_key') observed;
 IF actual IS NULL THEN
  EXECUTE $object$CREATE TRIGGER zzz_pod_signing_key_follows_pod_key BEFORE UPDATE ON personal_agent_registry FOR EACH ROW WHEN (new.pod_pubkey IS DISTINCT FROM old.pod_pubkey AND old.pod_signing_key_id IS NOT NULL AND NOT new.pod_signing_key_id IS DISTINCT FROM old.pod_signing_key_id) EXECUTE FUNCTION retire_superseded_pod_signing_key();$object$;
 ELSIF encode(sha256(convert_to(actual,'UTF8')),'hex') NOT IN ('bf2e3d96aaee9de6576bb74d8d03be1e6db8276e3549017f8fc38be0ee9662ce') THEN
  RAISE EXCEPTION 'Unqualified schema drift: zzz_pod_signing_key_follows_pod_key';
 END IF;
END
$object_guard$;

DO $pod_414$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.personal_agent_registry'::regclass AND tgname='zzz_pod_signing_key_follows_pod_key' AND tgenabled='O') THEN RAISE EXCEPTION 'Unqualified trigger state: zzz_pod_signing_key_follows_pod_key'; END IF;
END
$pod_414$;

DO $object_guard$
DECLARE actual text;
BEGIN
 SELECT definition INTO actual FROM (SELECT pg_get_triggerdef(t.oid,true) definition FROM pg_trigger t WHERE t.tgrelid='public.personal_agent_standby_placements'::regclass AND t.tgname='account_retired_generation_update') observed;
 IF actual IS NULL THEN
  EXECUTE $object$CREATE TRIGGER account_retired_generation_update BEFORE UPDATE ON personal_agent_standby_placements FOR EACH ROW EXECUTE FUNCTION reject_retired_account_update('user_id');$object$;
 ELSIF encode(sha256(convert_to(actual,'UTF8')),'hex') NOT IN ('3738f064652407630e0ba8fa6d6e36608c6823de8ae1cb820cc2eb48daf55bec') THEN
  RAISE EXCEPTION 'Unqualified schema drift: account_retired_generation_update';
 END IF;
END
$object_guard$;

DO $pod_414$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.personal_agent_standby_placements'::regclass AND tgname='account_retired_generation_update' AND tgenabled='O') THEN RAISE EXCEPTION 'Unqualified trigger state: account_retired_generation_update'; END IF;
END
$pod_414$;

DO $object_guard$
DECLARE actual text;
BEGIN
 SELECT definition INTO actual FROM (SELECT pg_get_triggerdef(t.oid,true) definition FROM pg_trigger t WHERE t.tgrelid='public.personal_agent_standby_placements'::regclass AND t.tgname='trg_reject_deleted_account_insert') observed;
 IF actual IS NULL THEN
  EXECUTE $object$CREATE TRIGGER trg_reject_deleted_account_insert BEFORE INSERT ON personal_agent_standby_placements FOR EACH ROW EXECUTE FUNCTION reject_deleted_account_identity_write('user_id');$object$;
 ELSIF encode(sha256(convert_to(actual,'UTF8')),'hex') NOT IN ('176718d946193a0faa05e8e01bfe2e53f3f2833eb2cedd99f14f9361cab9c2a5') THEN
  RAISE EXCEPTION 'Unqualified schema drift: trg_reject_deleted_account_insert';
 END IF;
END
$object_guard$;

DO $pod_414$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.personal_agent_standby_placements'::regclass AND tgname='trg_reject_deleted_account_insert' AND tgenabled='O') THEN RAISE EXCEPTION 'Unqualified trigger state: trg_reject_deleted_account_insert'; END IF;
END
$pod_414$;

DO $object_guard$
DECLARE actual text;
BEGIN
 SELECT definition INTO actual FROM (SELECT pg_get_triggerdef(t.oid,true) definition FROM pg_trigger t WHERE t.tgrelid='public.personal_agent_standby_placements'::regclass AND t.tgname='trg_reject_deleted_account_reference_update') observed;
 IF actual IS NULL THEN
  EXECUTE $object$CREATE TRIGGER trg_reject_deleted_account_reference_update BEFORE UPDATE OF user_id ON personal_agent_standby_placements FOR EACH ROW EXECUTE FUNCTION reject_deleted_account_identity_write('user_id');$object$;
 ELSIF encode(sha256(convert_to(actual,'UTF8')),'hex') NOT IN ('b20e8c3a054ff240646d337ace9aff3dc22b92026dda5356f0a75cfb7eb9e1a2') THEN
  RAISE EXCEPTION 'Unqualified schema drift: trg_reject_deleted_account_reference_update';
 END IF;
END
$object_guard$;

DO $pod_414$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.personal_agent_standby_placements'::regclass AND tgname='trg_reject_deleted_account_reference_update' AND tgenabled='O') THEN RAISE EXCEPTION 'Unqualified trigger state: trg_reject_deleted_account_reference_update'; END IF;
END
$pod_414$;

DO $object_guard$
DECLARE actual text;
BEGIN
 SELECT definition INTO actual FROM (SELECT pg_get_triggerdef(t.oid,true) definition FROM pg_trigger t WHERE t.tgrelid='public.personal_agent_standby_placements'::regclass AND t.tgname='zw_azure_vm_power_standby') observed;
 IF actual IS NULL THEN
  EXECUTE $object$CREATE TRIGGER zw_azure_vm_power_standby BEFORE INSERT OR DELETE OR UPDATE ON personal_agent_standby_placements FOR EACH ROW EXECUTE FUNCTION guard_azure_vm_power_standby();$object$;
 ELSIF encode(sha256(convert_to(actual,'UTF8')),'hex') NOT IN ('11d0964a08bc7b005adb94419035e559196bd831f54fc5960d23bf45b3d243f8') THEN
  RAISE EXCEPTION 'Unqualified schema drift: zw_azure_vm_power_standby';
 END IF;
END
$object_guard$;

DO $pod_414$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.personal_agent_standby_placements'::regclass AND tgname='zw_azure_vm_power_standby' AND tgenabled='O') THEN RAISE EXCEPTION 'Unqualified trigger state: zw_azure_vm_power_standby'; END IF;
END
$pod_414$;

DO $object_guard$
DECLARE actual text;
BEGIN
 SELECT definition INTO actual FROM (SELECT pg_get_triggerdef(t.oid,true) definition FROM pg_trigger t WHERE t.tgrelid='public.personal_agent_standby_placements'::regclass AND t.tgname='zx_personal_agent_standby_placement') observed;
 IF actual IS NULL THEN
  EXECUTE $object$CREATE CONSTRAINT TRIGGER zx_personal_agent_standby_placement AFTER INSERT OR UPDATE ON personal_agent_standby_placements DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION guard_personal_agent_standby_placement();$object$;
 ELSIF encode(sha256(convert_to(actual,'UTF8')),'hex') NOT IN ('c630bf60fde544ad4f1b39160d633bc6b5b47eb66ff87f01e79424b4b3cd17c5') THEN
  RAISE EXCEPTION 'Unqualified schema drift: zx_personal_agent_standby_placement';
 END IF;
END
$object_guard$;

DO $pod_414$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.personal_agent_standby_placements'::regclass AND tgname='zx_personal_agent_standby_placement' AND tgenabled='O') THEN RAISE EXCEPTION 'Unqualified trigger state: zx_personal_agent_standby_placement'; END IF;
END
$pod_414$;

DO $object_guard$
DECLARE actual text;
BEGIN
 SELECT definition INTO actual FROM (SELECT pg_get_triggerdef(t.oid,true) definition FROM pg_trigger t WHERE t.tgrelid='public.personal_agent_standby_placements'::regclass AND t.tgname='zz_personal_agent_notification_standby_retention') observed;
 IF actual IS NULL THEN
  EXECUTE $object$CREATE CONSTRAINT TRIGGER zz_personal_agent_notification_standby_retention AFTER DELETE OR UPDATE ON personal_agent_standby_placements DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION guard_personal_agent_notification_standby_retention();$object$;
 ELSIF encode(sha256(convert_to(actual,'UTF8')),'hex') NOT IN ('086e6e70246e05db1ca70d2c2c976e56a1e974c5eb21ab9cc950cca4d8ce770b') THEN
  RAISE EXCEPTION 'Unqualified schema drift: zz_personal_agent_notification_standby_retention';
 END IF;
END
$object_guard$;

DO $pod_414$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.personal_agent_standby_placements'::regclass AND tgname='zz_personal_agent_notification_standby_retention' AND tgenabled='O') THEN RAISE EXCEPTION 'Unqualified trigger state: zz_personal_agent_notification_standby_retention'; END IF;
END
$pod_414$;

DO $object_guard$
DECLARE actual text;
BEGIN
 SELECT definition INTO actual FROM (SELECT pg_get_triggerdef(t.oid,true) definition FROM pg_trigger t WHERE t.tgrelid='public.pod_lifecycle_events'::regclass AND t.tgname='account_retired_generation_update') observed;
 IF actual IS NULL THEN
  EXECUTE $object$CREATE TRIGGER account_retired_generation_update BEFORE UPDATE ON pod_lifecycle_events FOR EACH ROW EXECUTE FUNCTION reject_retired_account_update('user_id');$object$;
 ELSIF encode(sha256(convert_to(actual,'UTF8')),'hex') NOT IN ('1dc7c6386a3d5b3ad6933548d76db1226665b9ce220764c435d08be28d1ea828') THEN
  RAISE EXCEPTION 'Unqualified schema drift: account_retired_generation_update';
 END IF;
END
$object_guard$;

DO $pod_414$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.pod_lifecycle_events'::regclass AND tgname='account_retired_generation_update' AND tgenabled='O') THEN RAISE EXCEPTION 'Unqualified trigger state: account_retired_generation_update'; END IF;
END
$pod_414$;

DO $object_guard$
DECLARE actual text;
BEGIN
 SELECT definition INTO actual FROM (SELECT pg_get_triggerdef(t.oid,true) definition FROM pg_trigger t WHERE t.tgrelid='public.pod_lifecycle_events'::regclass AND t.tgname='pod_lifecycle_after_insert') observed;
 IF actual IS NULL THEN
  EXECUTE $object$CREATE TRIGGER pod_lifecycle_after_insert AFTER INSERT ON pod_lifecycle_events FOR EACH ROW EXECUTE FUNCTION pod_lifecycle_notify();$object$;
 ELSIF encode(sha256(convert_to(actual,'UTF8')),'hex') NOT IN ('7b5d34824354ea42281ebc9f0680a6530da1822a49a044013dee7d773c21ed41') THEN
  RAISE EXCEPTION 'Unqualified schema drift: pod_lifecycle_after_insert';
 END IF;
END
$object_guard$;

DO $pod_414$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.pod_lifecycle_events'::regclass AND tgname='pod_lifecycle_after_insert' AND tgenabled='O') THEN RAISE EXCEPTION 'Unqualified trigger state: pod_lifecycle_after_insert'; END IF;
END
$pod_414$;

DO $object_guard$
DECLARE actual text;
BEGIN
 SELECT definition INTO actual FROM (SELECT pg_get_triggerdef(t.oid,true) definition FROM pg_trigger t WHERE t.tgrelid='public.pod_lifecycle_events'::regclass AND t.tgname='trg_reject_deleted_account_insert') observed;
 IF actual IS NULL THEN
  EXECUTE $object$CREATE TRIGGER trg_reject_deleted_account_insert BEFORE INSERT ON pod_lifecycle_events FOR EACH ROW EXECUTE FUNCTION reject_deleted_account_identity_write('user_id');$object$;
 ELSIF encode(sha256(convert_to(actual,'UTF8')),'hex') NOT IN ('ce3a9fc983ab35a9924d5b9c49b9ffce157ef50edd6205569638b673ef3a79be') THEN
  RAISE EXCEPTION 'Unqualified schema drift: trg_reject_deleted_account_insert';
 END IF;
END
$object_guard$;

DO $pod_414$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.pod_lifecycle_events'::regclass AND tgname='trg_reject_deleted_account_insert' AND tgenabled='O') THEN RAISE EXCEPTION 'Unqualified trigger state: trg_reject_deleted_account_insert'; END IF;
END
$pod_414$;

DO $object_guard$
DECLARE actual text;
BEGIN
 SELECT definition INTO actual FROM (SELECT pg_get_triggerdef(t.oid,true) definition FROM pg_trigger t WHERE t.tgrelid='public.pod_lifecycle_events'::regclass AND t.tgname='trg_reject_deleted_account_reference_update') observed;
 IF actual IS NULL THEN
  EXECUTE $object$CREATE TRIGGER trg_reject_deleted_account_reference_update BEFORE UPDATE OF user_id ON pod_lifecycle_events FOR EACH ROW EXECUTE FUNCTION reject_deleted_account_identity_write('user_id');$object$;
 ELSIF encode(sha256(convert_to(actual,'UTF8')),'hex') NOT IN ('056f6071eccac3c7b112cfe133696747a8c8549a4f4449c761bad21b637776cb') THEN
  RAISE EXCEPTION 'Unqualified schema drift: trg_reject_deleted_account_reference_update';
 END IF;
END
$object_guard$;

DO $pod_414$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.pod_lifecycle_events'::regclass AND tgname='trg_reject_deleted_account_reference_update' AND tgenabled='O') THEN RAISE EXCEPTION 'Unqualified trigger state: trg_reject_deleted_account_reference_update'; END IF;
END
$pod_414$;

DO $object_guard$
DECLARE actual text;
BEGIN
 SELECT definition INTO actual FROM (SELECT pg_get_triggerdef(t.oid,true) definition FROM pg_trigger t WHERE t.tgrelid='public.pod_migration_jobs'::regclass AND t.tgname='account_retired_generation_update') observed;
 IF actual IS NULL THEN
  EXECUTE $object$CREATE TRIGGER account_retired_generation_update BEFORE UPDATE ON pod_migration_jobs FOR EACH ROW EXECUTE FUNCTION reject_retired_account_update('user_id');$object$;
 ELSIF encode(sha256(convert_to(actual,'UTF8')),'hex') NOT IN ('40e6c4033ea5d21673bc1d4fa8e4622374cadc1e3b60c24d273c273d207cf179') THEN
  RAISE EXCEPTION 'Unqualified schema drift: account_retired_generation_update';
 END IF;
END
$object_guard$;

DO $pod_414$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.pod_migration_jobs'::regclass AND tgname='account_retired_generation_update' AND tgenabled='O') THEN RAISE EXCEPTION 'Unqualified trigger state: account_retired_generation_update'; END IF;
END
$pod_414$;

DO $object_guard$
DECLARE actual text;
BEGIN
 SELECT definition INTO actual FROM (SELECT pg_get_triggerdef(t.oid,true) definition FROM pg_trigger t WHERE t.tgrelid='public.pod_migration_jobs'::regclass AND t.tgname='trg_reject_deleted_account_insert') observed;
 IF actual IS NULL THEN
  EXECUTE $object$CREATE TRIGGER trg_reject_deleted_account_insert BEFORE INSERT ON pod_migration_jobs FOR EACH ROW EXECUTE FUNCTION reject_deleted_account_identity_write('user_id');$object$;
 ELSIF encode(sha256(convert_to(actual,'UTF8')),'hex') NOT IN ('bde1d75d5a00cc8f4144919a65e742f18bbd61470f110d7e07dbe3d7a8ddaa00') THEN
  RAISE EXCEPTION 'Unqualified schema drift: trg_reject_deleted_account_insert';
 END IF;
END
$object_guard$;

DO $pod_414$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.pod_migration_jobs'::regclass AND tgname='trg_reject_deleted_account_insert' AND tgenabled='O') THEN RAISE EXCEPTION 'Unqualified trigger state: trg_reject_deleted_account_insert'; END IF;
END
$pod_414$;

DO $object_guard$
DECLARE actual text;
BEGIN
 SELECT definition INTO actual FROM (SELECT pg_get_triggerdef(t.oid,true) definition FROM pg_trigger t WHERE t.tgrelid='public.pod_migration_jobs'::regclass AND t.tgname='trg_reject_deleted_account_reference_update') observed;
 IF actual IS NULL THEN
  EXECUTE $object$CREATE TRIGGER trg_reject_deleted_account_reference_update BEFORE UPDATE OF user_id ON pod_migration_jobs FOR EACH ROW EXECUTE FUNCTION reject_deleted_account_identity_write('user_id');$object$;
 ELSIF encode(sha256(convert_to(actual,'UTF8')),'hex') NOT IN ('567c7a953dcf667d2839fab3f774bd10127951ba3193fdcddefaae6d792adad6') THEN
  RAISE EXCEPTION 'Unqualified schema drift: trg_reject_deleted_account_reference_update';
 END IF;
END
$object_guard$;

DO $pod_414$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.pod_migration_jobs'::regclass AND tgname='trg_reject_deleted_account_reference_update' AND tgenabled='O') THEN RAISE EXCEPTION 'Unqualified trigger state: trg_reject_deleted_account_reference_update'; END IF;
END
$pod_414$;

DO $object_guard$
DECLARE actual text;
BEGIN
 SELECT definition INTO actual FROM (SELECT pg_get_triggerdef(t.oid,true) definition FROM pg_trigger t WHERE t.tgrelid='public.pod_migration_jobs'::regclass AND t.tgname='zv_azure_vm_power') observed;
 IF actual IS NULL THEN
  EXECUTE $object$CREATE TRIGGER zv_azure_vm_power BEFORE INSERT OR DELETE OR UPDATE ON pod_migration_jobs FOR EACH ROW EXECUTE FUNCTION guard_azure_vm_power_standby();$object$;
 ELSIF encode(sha256(convert_to(actual,'UTF8')),'hex') NOT IN ('d5da5e103b0dba220529c1fae8f7ec5e4ff63e43d91e3a6acbbf781121e12689') THEN
  RAISE EXCEPTION 'Unqualified schema drift: zv_azure_vm_power';
 END IF;
END
$object_guard$;

DO $pod_414$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.pod_migration_jobs'::regclass AND tgname='zv_azure_vm_power' AND tgenabled='O') THEN RAISE EXCEPTION 'Unqualified trigger state: zv_azure_vm_power'; END IF;
END
$pod_414$;

DO $object_guard$
DECLARE actual text;
BEGIN
 SELECT definition INTO actual FROM (SELECT pg_get_triggerdef(t.oid,true) definition FROM pg_trigger t WHERE t.tgrelid='public.shared_files_storage'::regclass AND t.tgname='account_retired_generation_update') observed;
 IF actual IS NULL THEN
  EXECUTE $object$CREATE TRIGGER account_retired_generation_update BEFORE UPDATE ON shared_files_storage FOR EACH ROW EXECUTE FUNCTION reject_retired_account_update('user_id');$object$;
 ELSIF encode(sha256(convert_to(actual,'UTF8')),'hex') NOT IN ('7b7809bc4639e859c22e24bcf2a58b5220c826ed9a56fdebc9f9697f81b2669e') THEN
  RAISE EXCEPTION 'Unqualified schema drift: account_retired_generation_update';
 END IF;
END
$object_guard$;

DO $pod_414$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.shared_files_storage'::regclass AND tgname='account_retired_generation_update' AND tgenabled='O') THEN RAISE EXCEPTION 'Unqualified trigger state: account_retired_generation_update'; END IF;
END
$pod_414$;

DO $object_guard$
DECLARE actual text;
BEGIN
 SELECT definition INTO actual FROM (SELECT pg_get_triggerdef(t.oid,true) definition FROM pg_trigger t WHERE t.tgrelid='public.shared_files_storage'::regclass AND t.tgname='trg_reject_deleted_account_insert') observed;
 IF actual IS NULL THEN
  EXECUTE $object$CREATE TRIGGER trg_reject_deleted_account_insert BEFORE INSERT ON shared_files_storage FOR EACH ROW EXECUTE FUNCTION reject_deleted_account_identity_write('user_id');$object$;
 ELSIF encode(sha256(convert_to(actual,'UTF8')),'hex') NOT IN ('b98a30fd62344d72854a56f1ea2c08d294803f61cd24610f9e43892476520359') THEN
  RAISE EXCEPTION 'Unqualified schema drift: trg_reject_deleted_account_insert';
 END IF;
END
$object_guard$;

DO $pod_414$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.shared_files_storage'::regclass AND tgname='trg_reject_deleted_account_insert' AND tgenabled='O') THEN RAISE EXCEPTION 'Unqualified trigger state: trg_reject_deleted_account_insert'; END IF;
END
$pod_414$;

DO $object_guard$
DECLARE actual text;
BEGIN
 SELECT definition INTO actual FROM (SELECT pg_get_triggerdef(t.oid,true) definition FROM pg_trigger t WHERE t.tgrelid='public.shared_files_storage'::regclass AND t.tgname='trg_reject_deleted_account_reference_update') observed;
 IF actual IS NULL THEN
  EXECUTE $object$CREATE TRIGGER trg_reject_deleted_account_reference_update BEFORE UPDATE OF user_id ON shared_files_storage FOR EACH ROW EXECUTE FUNCTION reject_deleted_account_identity_write('user_id');$object$;
 ELSIF encode(sha256(convert_to(actual,'UTF8')),'hex') NOT IN ('ffe0b4b23ad15782a920f9ccb0f05a1949e9b7fc0891daa9e22c8e8dfe2e74c3') THEN
  RAISE EXCEPTION 'Unqualified schema drift: trg_reject_deleted_account_reference_update';
 END IF;
END
$object_guard$;

DO $pod_414$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.shared_files_storage'::regclass AND tgname='trg_reject_deleted_account_reference_update' AND tgenabled='O') THEN RAISE EXCEPTION 'Unqualified trigger state: trg_reject_deleted_account_reference_update'; END IF;
END
$pod_414$;

DO $object_guard$
DECLARE actual text;
BEGIN
 SELECT definition INTO actual FROM (SELECT pg_get_triggerdef(t.oid,true) definition FROM pg_trigger t WHERE t.tgrelid='public.webauthn_challenges'::regclass AND t.tgname='account_retired_generation_update') observed;
 IF actual IS NULL THEN
  EXECUTE $object$CREATE TRIGGER account_retired_generation_update BEFORE UPDATE ON webauthn_challenges FOR EACH ROW EXECUTE FUNCTION reject_retired_account_update('user_id');$object$;
 ELSIF encode(sha256(convert_to(actual,'UTF8')),'hex') NOT IN ('ac8d3879e730928e42cc5052f4ae15d2cdc8ee3523e13ba1d07e84df6ca7b178') THEN
  RAISE EXCEPTION 'Unqualified schema drift: account_retired_generation_update';
 END IF;
END
$object_guard$;

DO $pod_414$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.webauthn_challenges'::regclass AND tgname='account_retired_generation_update' AND tgenabled='O') THEN RAISE EXCEPTION 'Unqualified trigger state: account_retired_generation_update'; END IF;
END
$pod_414$;

DO $object_guard$
DECLARE actual text;
BEGIN
 SELECT definition INTO actual FROM (SELECT pg_get_triggerdef(t.oid,true) definition FROM pg_trigger t WHERE t.tgrelid='public.webauthn_challenges'::regclass AND t.tgname='trg_reject_deleted_account_insert') observed;
 IF actual IS NULL THEN
  EXECUTE $object$CREATE TRIGGER trg_reject_deleted_account_insert BEFORE INSERT ON webauthn_challenges FOR EACH ROW EXECUTE FUNCTION reject_deleted_account_identity_write('user_id');$object$;
 ELSIF encode(sha256(convert_to(actual,'UTF8')),'hex') NOT IN ('06f1a183143b5ebd6fe71ede3193ac225270886af80fa6cc9210dd3577cf05cc') THEN
  RAISE EXCEPTION 'Unqualified schema drift: trg_reject_deleted_account_insert';
 END IF;
END
$object_guard$;

DO $pod_414$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.webauthn_challenges'::regclass AND tgname='trg_reject_deleted_account_insert' AND tgenabled='O') THEN RAISE EXCEPTION 'Unqualified trigger state: trg_reject_deleted_account_insert'; END IF;
END
$pod_414$;

DO $object_guard$
DECLARE actual text;
BEGIN
 SELECT definition INTO actual FROM (SELECT pg_get_triggerdef(t.oid,true) definition FROM pg_trigger t WHERE t.tgrelid='public.webauthn_challenges'::regclass AND t.tgname='trg_reject_deleted_account_reference_update') observed;
 IF actual IS NULL THEN
  EXECUTE $object$CREATE TRIGGER trg_reject_deleted_account_reference_update BEFORE UPDATE OF user_id ON webauthn_challenges FOR EACH ROW EXECUTE FUNCTION reject_deleted_account_identity_write('user_id');$object$;
 ELSIF encode(sha256(convert_to(actual,'UTF8')),'hex') NOT IN ('744720cb0d4c5b9e20738b7aad74745d675290c9ce0f5efbe603e9e69ec14258') THEN
  RAISE EXCEPTION 'Unqualified schema drift: trg_reject_deleted_account_reference_update';
 END IF;
END
$object_guard$;

DO $pod_414$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.webauthn_challenges'::regclass AND tgname='trg_reject_deleted_account_reference_update' AND tgenabled='O') THEN RAISE EXCEPTION 'Unqualified trigger state: trg_reject_deleted_account_reference_update'; END IF;
END
$pod_414$;

DO $object_guard$
DECLARE actual text;
BEGIN
 SELECT definition INTO actual FROM (SELECT pg_get_triggerdef(t.oid,true) definition FROM pg_trigger t WHERE t.tgrelid='public.webauthn_credentials'::regclass AND t.tgname='account_retired_generation_update') observed;
 IF actual IS NULL THEN
  EXECUTE $object$CREATE TRIGGER account_retired_generation_update BEFORE UPDATE ON webauthn_credentials FOR EACH ROW EXECUTE FUNCTION reject_retired_account_update('user_id');$object$;
 ELSIF encode(sha256(convert_to(actual,'UTF8')),'hex') NOT IN ('9e190896544350eaa012107dcf4d023592ba6ff142f33a9a07264b2196af7c74') THEN
  RAISE EXCEPTION 'Unqualified schema drift: account_retired_generation_update';
 END IF;
END
$object_guard$;

DO $pod_414$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.webauthn_credentials'::regclass AND tgname='account_retired_generation_update' AND tgenabled='O') THEN RAISE EXCEPTION 'Unqualified trigger state: account_retired_generation_update'; END IF;
END
$pod_414$;

DO $object_guard$
DECLARE actual text;
BEGIN
 SELECT definition INTO actual FROM (SELECT pg_get_triggerdef(t.oid,true) definition FROM pg_trigger t WHERE t.tgrelid='public.webauthn_credentials'::regclass AND t.tgname='trg_reject_deleted_account_insert') observed;
 IF actual IS NULL THEN
  EXECUTE $object$CREATE TRIGGER trg_reject_deleted_account_insert BEFORE INSERT ON webauthn_credentials FOR EACH ROW EXECUTE FUNCTION reject_deleted_account_identity_write('user_id');$object$;
 ELSIF encode(sha256(convert_to(actual,'UTF8')),'hex') NOT IN ('89384dd7829b7a7e676586d91fc7579baf109daf1c6e5a1f3e4a5cf1ea64fdeb') THEN
  RAISE EXCEPTION 'Unqualified schema drift: trg_reject_deleted_account_insert';
 END IF;
END
$object_guard$;

DO $pod_414$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.webauthn_credentials'::regclass AND tgname='trg_reject_deleted_account_insert' AND tgenabled='O') THEN RAISE EXCEPTION 'Unqualified trigger state: trg_reject_deleted_account_insert'; END IF;
END
$pod_414$;

DO $object_guard$
DECLARE actual text;
BEGIN
 SELECT definition INTO actual FROM (SELECT pg_get_triggerdef(t.oid,true) definition FROM pg_trigger t WHERE t.tgrelid='public.webauthn_credentials'::regclass AND t.tgname='trg_reject_deleted_account_reference_update') observed;
 IF actual IS NULL THEN
  EXECUTE $object$CREATE TRIGGER trg_reject_deleted_account_reference_update BEFORE UPDATE OF user_id ON webauthn_credentials FOR EACH ROW EXECUTE FUNCTION reject_deleted_account_identity_write('user_id');$object$;
 ELSIF encode(sha256(convert_to(actual,'UTF8')),'hex') NOT IN ('5f903968f49b89ae72f775ec0a24b7eaea693fb7f66a5200d5be029b0f3b3186') THEN
  RAISE EXCEPTION 'Unqualified schema drift: trg_reject_deleted_account_reference_update';
 END IF;
END
$object_guard$;

DO $pod_414$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.webauthn_credentials'::regclass AND tgname='trg_reject_deleted_account_reference_update' AND tgenabled='O') THEN RAISE EXCEPTION 'Unqualified trigger state: trg_reject_deleted_account_reference_update'; END IF;
END
$pod_414$;

DO $pod_414$
BEGIN
 IF EXISTS(SELECT 1 FROM pg_depend d JOIN pg_class c ON d.refobjid=c.oid JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum=d.refobjsubid WHERE d.classid='pg_class'::regclass AND d.objid='public.agent_prompt_versions_id_seq'::regclass AND d.deptype='a' AND (c.relname<>'agent_prompt_versions' OR a.attname<>'id')) THEN RAISE EXCEPTION 'Unqualified private-agent sequence ownership'; END IF;
END
$pod_414$;

ALTER SEQUENCE public."agent_prompt_versions_id_seq" OWNED BY public."agent_prompt_versions"."id";

DO $pod_414$
BEGIN
 IF EXISTS(SELECT 1 FROM pg_depend d JOIN pg_class c ON d.refobjid=c.oid JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum=d.refobjsubid WHERE d.classid='pg_class'::regclass AND d.objid='public.consent_audit_receipts_id_seq'::regclass AND d.deptype='a' AND (c.relname<>'consent_audit_receipts' OR a.attname<>'id')) THEN RAISE EXCEPTION 'Unqualified private-agent sequence ownership'; END IF;
END
$pod_414$;

ALTER SEQUENCE public."consent_audit_receipts_id_seq" OWNED BY public."consent_audit_receipts"."id";

DO $pod_414$
BEGIN
 IF EXISTS(SELECT 1 FROM pg_depend d JOIN pg_class c ON d.refobjid=c.oid JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum=d.refobjsubid WHERE d.classid='pg_class'::regclass AND d.objid='public.personal_agent_deletion_tombstones_id_seq'::regclass AND d.deptype='a' AND (c.relname<>'personal_agent_deletion_tombstones' OR a.attname<>'id')) THEN RAISE EXCEPTION 'Unqualified private-agent sequence ownership'; END IF;
END
$pod_414$;

ALTER SEQUENCE public."personal_agent_deletion_tombstones_id_seq" OWNED BY public."personal_agent_deletion_tombstones"."id";

DO $pod_414$
BEGIN
 IF EXISTS(SELECT 1 FROM pg_depend d JOIN pg_class c ON d.refobjid=c.oid JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum=d.refobjsubid WHERE d.classid='pg_class'::regclass AND d.objid='public.webauthn_challenges_id_seq'::regclass AND d.deptype='a' AND (c.relname<>'webauthn_challenges' OR a.attname<>'id')) THEN RAISE EXCEPTION 'Unqualified private-agent sequence ownership'; END IF;
END
$pod_414$;

ALTER SEQUENCE public."webauthn_challenges_id_seq" OWNED BY public."webauthn_challenges"."id";

DO $pod_414$
BEGIN
 IF EXISTS(SELECT 1 FROM pg_depend d JOIN pg_class c ON d.refobjid=c.oid JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum=d.refobjsubid WHERE d.classid='pg_class'::regclass AND d.objid='public.webauthn_credentials_id_seq'::regclass AND d.deptype='a' AND (c.relname<>'webauthn_credentials' OR a.attname<>'id')) THEN RAISE EXCEPTION 'Unqualified private-agent sequence ownership'; END IF;
END
$pod_414$;

ALTER SEQUENCE public."webauthn_credentials_id_seq" OWNED BY public."webauthn_credentials"."id";

DO $custody_acl$
DECLARE client_role text;
BEGIN
 FOREACH client_role IN ARRAY ARRAY['anon','authenticated'] LOOP
  IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname=client_role) THEN CONTINUE; END IF;

  EXECUTE format('REVOKE ALL ON TABLE public.%I FROM %I','account_deletion_tombstones',client_role);

  EXECUTE format('REVOKE ALL ON TABLE public.%I FROM %I','agent_prompt_versions',client_role);

  EXECUTE format('REVOKE ALL ON TABLE public.%I FROM %I','byoc_setup_jobs',client_role);

  EXECUTE format('REVOKE ALL ON TABLE public.%I FROM %I','consent_audit',client_role);

  EXECUTE format('REVOKE ALL ON TABLE public.%I FROM %I','consent_audit_receipts',client_role);

  EXECUTE format('REVOKE ALL ON TABLE public.%I FROM %I','one_action_directive_ledger',client_role);

  EXECUTE format('REVOKE ALL ON TABLE public.%I FROM %I','personal_agent_cloud_removals',client_role);

  EXECUTE format('REVOKE ALL ON TABLE public.%I FROM %I','personal_agent_deletion_tombstones',client_role);

  EXECUTE format('REVOKE ALL ON TABLE public.%I FROM %I','personal_agent_registry',client_role);

  EXECUTE format('REVOKE ALL ON TABLE public.%I FROM %I','personal_agent_standby_placements',client_role);

  EXECUTE format('REVOKE ALL ON TABLE public.%I FROM %I','pod_lifecycle_events',client_role);

  EXECUTE format('REVOKE ALL ON TABLE public.%I FROM %I','pod_migration_jobs',client_role);

  EXECUTE format('REVOKE ALL ON TABLE public.%I FROM %I','pod_request_nonces',client_role);

  EXECUTE format('REVOKE ALL ON TABLE public.%I FROM %I','shared_files_storage',client_role);

  EXECUTE format('REVOKE ALL ON TABLE public.%I FROM %I','webauthn_challenges',client_role);

  EXECUTE format('REVOKE ALL ON TABLE public.%I FROM %I','webauthn_credentials',client_role);

  EXECUTE format('REVOKE ALL ON FUNCTION public."approve_azure_erasure_plan"(text, text, text, text) FROM %I',client_role);

  EXECUTE format('REVOKE ALL ON FUNCTION public."approve_personal_agent_cloud_removal"(text, text, text, text) FROM %I',client_role);

  EXECUTE format('REVOKE ALL ON FUNCTION public."assert_azure_erasure_worker"(text, text, text) FROM %I',client_role);

  EXECUTE format('REVOKE ALL ON FUNCTION public."assert_project_grant_admission"(text) FROM %I',client_role);

  EXECUTE format('REVOKE ALL ON FUNCTION public."azure_account_cleanup_ready"() FROM %I',client_role);

  EXECUTE format('REVOKE ALL ON FUNCTION public."azure_browser_update_admission_ready"() FROM %I',client_role);

  EXECUTE format('REVOKE ALL ON FUNCTION public."azure_cleanup_candidate_digest"(jsonb) FROM %I',client_role);

  EXECUTE format('REVOKE ALL ON FUNCTION public."azure_cleanup_cloud_purpose_authorized"(text, text) FROM %I',client_role);

  EXECUTE format('REVOKE ALL ON FUNCTION public."azure_cleanup_information_erased"(text, jsonb) FROM %I',client_role);

  EXECUTE format('REVOKE ALL ON FUNCTION public."azure_erasure_absence_settled"(jsonb) FROM %I',client_role);

  EXECUTE format('REVOKE ALL ON FUNCTION public."azure_erasure_authorization"(text, text) FROM %I',client_role);

  EXECUTE format('REVOKE ALL ON FUNCTION public."azure_erasure_context"(text) FROM %I',client_role);

  EXECUTE format('REVOKE ALL ON FUNCTION public."azure_erasure_execution_receipt"(jsonb, text, text) FROM %I',client_role);

  EXECUTE format('REVOKE ALL ON FUNCTION public."azure_erasure_request_retryable"(jsonb) FROM %I',client_role);

  EXECUTE format('REVOKE ALL ON FUNCTION public."azure_erasure_resources_complete"(text, jsonb) FROM %I',client_role);

  EXECUTE format('REVOKE ALL ON FUNCTION public."azure_erasure_setup_history"(text) FROM %I',client_role);

  EXECUTE format('REVOKE ALL ON FUNCTION public."azure_erasure_writers_drained"(text) FROM %I',client_role);

  EXECUTE format('REVOKE ALL ON FUNCTION public."azure_files_upgrade_admission_ready"() FROM %I',client_role);

  EXECUTE format('REVOKE ALL ON FUNCTION public."azure_setup_never_deployed"(text, jsonb) FROM %I',client_role);

  EXECUTE format('REVOKE ALL ON FUNCTION public."azure_setup_no_effects"(text) FROM %I',client_role);

  EXECUTE format('REVOKE ALL ON FUNCTION public."azure_setup_predeployment_proven"(text, jsonb, boolean) FROM %I',client_role);

  EXECUTE format('REVOKE ALL ON FUNCTION public."azure_vm_image_publication_proven"(personal_agent_registry, personal_agent_registry) FROM %I',client_role);

  EXECUTE format('REVOKE ALL ON FUNCTION public."azure_vm_power_binding"(jsonb) FROM %I',client_role);

  EXECUTE format('REVOKE ALL ON FUNCTION public."azure_vm_power_eligible"(jsonb) FROM %I',client_role);

  EXECUTE format('REVOKE ALL ON FUNCTION public."azure_vm_power_pending"(jsonb) FROM %I',client_role);

  EXECUTE format('REVOKE ALL ON FUNCTION public."azure_vm_power_phase_proven"(jsonb, text) FROM %I',client_role);

  EXECUTE format('REVOKE ALL ON FUNCTION public."azure_vm_upgrade_dispatch_settled"(jsonb, jsonb) FROM %I',client_role);

  EXECUTE format('REVOKE ALL ON FUNCTION public."azure_vm_upgrade_recovery_intent"(personal_agent_registry) FROM %I',client_role);

  EXECUTE format('REVOKE ALL ON FUNCTION public."azure_vm_upgrade_registry_binding"(jsonb) FROM %I',client_role);

  EXECUTE format('REVOKE ALL ON FUNCTION public."begin_azure_erasure_worker"(text, text, text) FROM %I',client_role);

  EXECUTE format('REVOKE ALL ON FUNCTION public."begin_byoc_azure_worker"(text, text, text) FROM %I',client_role);

  EXECUTE format('REVOKE ALL ON FUNCTION public."begin_byoc_azure_worker"(text, text, text, jsonb) FROM %I',client_role);

  EXECUTE format('REVOKE ALL ON FUNCTION public."block_unattempted_azure_vm_upgrade"(text, text, text, text, jsonb) FROM %I',client_role);

  EXECUTE format('REVOKE ALL ON FUNCTION public."browser_update_admission_ready"() FROM %I',client_role);

  EXECUTE format('REVOKE ALL ON FUNCTION public."byoc_azure_files_request_admitted"(text, jsonb) FROM %I',client_role);

  EXECUTE format('REVOKE ALL ON FUNCTION public."byoc_azure_intent_admitted"(personal_agent_registry, byoc_setup_jobs, jsonb, boolean) FROM %I',client_role);

  EXECUTE format('REVOKE ALL ON FUNCTION public."byoc_azure_live_worker_admitted"(text, text, boolean) FROM %I',client_role);

  EXECUTE format('REVOKE ALL ON FUNCTION public."byoc_azure_setup_guards_ready"() FROM %I',client_role);

  EXECUTE format('REVOKE ALL ON FUNCTION public."byoc_azure_vm_upgrade_admitted"(personal_agent_registry, byoc_setup_jobs, jsonb) FROM %I',client_role);

  EXECUTE format('REVOKE ALL ON FUNCTION public."byoc_azure_vm_upgrade_request_ready"(jsonb, jsonb, jsonb) FROM %I',client_role);

  EXECUTE format('REVOKE ALL ON FUNCTION public."byoc_azure_worker_admitted"(text, text) FROM %I',client_role);

  EXECUTE format('REVOKE ALL ON FUNCTION public."byoc_azure_worker_history_has_capacity"(jsonb) FROM %I',client_role);

  EXECUTE format('REVOKE ALL ON FUNCTION public."byoc_azure_worker_session_held"(text) FROM %I',client_role);

  EXECUTE format('REVOKE ALL ON FUNCTION public."claim_personal_agent_provision"(text, text, jsonb, jsonb) FROM %I',client_role);

  EXECUTE format('REVOKE ALL ON FUNCTION public."effective_erasure_azure_files_inventory"(jsonb) FROM %I',client_role);

  EXECUTE format('REVOKE ALL ON FUNCTION public."effective_erasure_substrate_inventory"(jsonb) FROM %I',client_role);

  EXECUTE format('REVOKE ALL ON FUNCTION public."erasure_mail_resource_state"(jsonb, text, text) FROM %I',client_role);

  EXECUTE format('REVOKE ALL ON FUNCTION public."erasure_mail_resources_deleted"(jsonb) FROM %I',client_role);

  EXECUTE format('REVOKE ALL ON FUNCTION public."erasure_never_hosted_admitted"(text, jsonb) FROM %I',client_role);

  EXECUTE format('REVOKE ALL ON FUNCTION public."erasure_planned_resources_covered"(jsonb) FROM %I',client_role);

  EXECUTE format('REVOKE ALL ON FUNCTION public."erasure_provider_revocation_complete"(jsonb) FROM %I',client_role);

  EXECUTE format('REVOKE ALL ON FUNCTION public."erasure_runtime_grants_complete"(jsonb) FROM %I',client_role);

  EXECUTE format('REVOKE ALL ON FUNCTION public."expected_erasure_bootstrap_release"(text, jsonb, text) FROM %I',client_role);

  EXECUTE format('REVOKE ALL ON FUNCTION public."expected_erasure_never_hosted"(text, jsonb) FROM %I',client_role);

  EXECUTE format('REVOKE ALL ON FUNCTION public."files_upgrade_admission_ready"() FROM %I',client_role);

  EXECUTE format('REVOKE ALL ON FUNCTION public."finalize_personal_agent_cloud_removal"(text, text, text) FROM %I',client_role);

  EXECUTE format('REVOKE ALL ON FUNCTION public."finalize_personal_agent_erasure"(text) FROM %I',client_role);

  EXECUTE format('REVOKE ALL ON FUNCTION public."guard_azure_vm_power_deletion"() FROM %I',client_role);

  EXECUTE format('REVOKE ALL ON FUNCTION public."guard_azure_vm_power_registry"() FROM %I',client_role);

  EXECUTE format('REVOKE ALL ON FUNCTION public."guard_azure_vm_power_standby"() FROM %I',client_role);

  EXECUTE format('REVOKE ALL ON FUNCTION public."guard_byoc_authorization_attempts"() FROM %I',client_role);

  EXECUTE format('REVOKE ALL ON FUNCTION public."guard_byoc_azure_erasure_job"() FROM %I',client_role);

  EXECUTE format('REVOKE ALL ON FUNCTION public."guard_personal_agent_cloud_removal"() FROM %I',client_role);

  EXECUTE format('REVOKE ALL ON FUNCTION public."guard_personal_agent_cloud_removal_history"() FROM %I',client_role);

  EXECUTE format('REVOKE ALL ON FUNCTION public."guard_personal_agent_erasure_archive"() FROM %I',client_role);

  EXECUTE format('REVOKE ALL ON FUNCTION public."guard_personal_agent_erasure_grant"() FROM %I',client_role);

  EXECUTE format('REVOKE ALL ON FUNCTION public."guard_personal_agent_erasure_registry"() FROM %I',client_role);

  EXECUTE format('REVOKE ALL ON FUNCTION public."guard_personal_agent_notification_registry"() FROM %I',client_role);

  EXECUTE format('REVOKE ALL ON FUNCTION public."guard_personal_agent_notification_retention"() FROM %I',client_role);

  EXECUTE format('REVOKE ALL ON FUNCTION public."guard_personal_agent_notification_standby_retention"() FROM %I',client_role);

  EXECUTE format('REVOKE ALL ON FUNCTION public."guard_personal_agent_provision_registry"() FROM %I',client_role);

  EXECUTE format('REVOKE ALL ON FUNCTION public."guard_personal_agent_renewal"() FROM %I',client_role);

  EXECUTE format('REVOKE ALL ON FUNCTION public."guard_personal_agent_standby_placement"() FROM %I',client_role);

  EXECUTE format('REVOKE ALL ON FUNCTION public."guard_project_grant_registry_admission"() FROM %I',client_role);

  EXECUTE format('REVOKE ALL ON FUNCTION public."guard_project_grant_setup_admission"() FROM %I',client_role);

  EXECUTE format('REVOKE ALL ON FUNCTION public."insert_personal_agent_renewal"(jsonb) FROM %I',client_role);

  EXECUTE format('REVOKE ALL ON FUNCTION public."notification_checkpoint_admission_ready"() FROM %I',client_role);

  EXECUTE format('REVOKE ALL ON FUNCTION public."notification_checkpoint_inventory"(jsonb, jsonb) FROM %I',client_role);

  EXECUTE format('REVOKE ALL ON FUNCTION public."notification_erasure_custody_archived"(text, jsonb, jsonb) FROM %I',client_role);

  EXECUTE format('REVOKE ALL ON FUNCTION public."notification_initial_host_binding"(jsonb, jsonb) FROM %I',client_role);

  EXECUTE format('REVOKE ALL ON FUNCTION public."notification_placement_custody"(jsonb) FROM %I',client_role);

  EXECUTE format('REVOKE ALL ON FUNCTION public."operator_mail_grants_qualified"(jsonb, text) FROM %I',client_role);

  EXECUTE format('REVOKE ALL ON FUNCTION public."operator_notification_custody_ready"() FROM %I',client_role);

  EXECUTE format('REVOKE ALL ON FUNCTION public."operator_topic_custody_preserved"(jsonb, jsonb) FROM %I',client_role);

  EXECUTE format('REVOKE ALL ON FUNCTION public."personal_agent_cloud_removal_covers"(text, jsonb) FROM %I',client_role);

  EXECUTE format('REVOKE ALL ON FUNCTION public."personal_agent_cloud_removal_execute_ready"(text, text) FROM %I',client_role);

  EXECUTE format('REVOKE ALL ON FUNCTION public."personal_agent_cloud_removal_identity"(jsonb, timestamp with time zone, text) FROM %I',client_role);

  EXECUTE format('REVOKE ALL ON FUNCTION public."personal_agent_cloud_removal_ready"() FROM %I',client_role);

  EXECUTE format('REVOKE ALL ON FUNCTION public."personal_agent_cloud_removal_replay_current"(text, text) FROM %I',client_role);

  EXECUTE format('REVOKE ALL ON FUNCTION public."personal_agent_cloud_removal_review"(jsonb) FROM %I',client_role);

  EXECUTE format('REVOKE ALL ON FUNCTION public."personal_agent_cloud_removed"(text) FROM %I',client_role);

  EXECUTE format('REVOKE ALL ON FUNCTION public."personal_agent_erasure_archive"(jsonb, jsonb) FROM %I',client_role);

  EXECUTE format('REVOKE ALL ON FUNCTION public."personal_agent_erasure_archived"(text, jsonb, jsonb) FROM %I',client_role);

  EXECUTE format('REVOKE ALL ON FUNCTION public."personal_agent_erasure_complete"(text) FROM %I',client_role);

  EXECUTE format('REVOKE ALL ON FUNCTION public."pod_lifecycle_notify"() FROM %I',client_role);

  EXECUTE format('REVOKE ALL ON FUNCTION public."project_grant_release_is_exclusive"(text, text) FROM %I',client_role);

  EXECUTE format('REVOKE ALL ON FUNCTION public."publish_personal_agent_notification_checkpoint"(text, text, text, text, bigint, jsonb) FROM %I',client_role);

  EXECUTE format('REVOKE ALL ON FUNCTION public."publish_personal_agent_provision"(text, text, text, text, jsonb) FROM %I',client_role);

  EXECUTE format('REVOKE ALL ON FUNCTION public."reserve_azure_account_cleanup"(text, text) FROM %I',client_role);

  EXECUTE format('REVOKE ALL ON FUNCTION public."reserve_erasure_bootstrap_grants"(text, text, jsonb, text) FROM %I',client_role);

  EXECUTE format('REVOKE ALL ON FUNCTION public."reserve_erasure_grant_release"(text, text, jsonb) FROM %I',client_role);

  EXECUTE format('REVOKE ALL ON FUNCTION public."reserve_personal_agent_cloud_removal"(text, text) FROM %I',client_role);

  EXECUTE format('REVOKE ALL ON FUNCTION public."reserve_personal_agent_erasure"(text, text) FROM %I',client_role);

  EXECUTE format('REVOKE ALL ON FUNCTION public."restore_personal_agent_erasure_reservation"(text, text, text, jsonb) FROM %I',client_role);

  EXECUTE format('REVOKE ALL ON FUNCTION public."retain_azure_cleanup_authorization_outcome"(text, text, text, text, text, text, text) FROM %I',client_role);

  EXECUTE format('REVOKE ALL ON FUNCTION public."retain_azure_erasure_execution_receipt"(text, text, text, text, text, jsonb) FROM %I',client_role);

  EXECUTE format('REVOKE ALL ON FUNCTION public."retain_azure_erasure_state"(text, text, jsonb, jsonb) FROM %I',client_role);

  EXECUTE format('REVOKE ALL ON FUNCTION public."retain_byoc_authorization"(text, text, jsonb, jsonb) FROM %I',client_role);

  EXECUTE format('REVOKE ALL ON FUNCTION public."retain_byoc_azure_setup_intent"(text, text, jsonb) FROM %I',client_role);

  EXECUTE format('REVOKE ALL ON FUNCTION public."retain_byoc_azure_worker_event"(text, text, jsonb) FROM %I',client_role);

  EXECUTE format('REVOKE ALL ON FUNCTION public."retain_erasure_account_receipt"(text, text, jsonb, text, jsonb) FROM %I',client_role);

  EXECUTE format('REVOKE ALL ON FUNCTION public."retain_erasure_bootstrap_grant_receipt"(text, text, jsonb, text, text, jsonb) FROM %I',client_role);

  EXECUTE format('REVOKE ALL ON FUNCTION public."retain_erasure_bucket_receipt"(text, text, jsonb, text, jsonb) FROM %I',client_role);

  EXECUTE format('REVOKE ALL ON FUNCTION public."retain_erasure_compute_receipt"(text, text, jsonb, text, jsonb) FROM %I',client_role);

  EXECUTE format('REVOKE ALL ON FUNCTION public."retain_erasure_files_receipt"(text, text, jsonb, text, text, jsonb) FROM %I',client_role);

  EXECUTE format('REVOKE ALL ON FUNCTION public."retain_erasure_files_upgrade_observation"(text, text, jsonb) FROM %I',client_role);

  EXECUTE format('REVOKE ALL ON FUNCTION public."retain_erasure_kms_receipt"(text, text, jsonb, text, jsonb) FROM %I',client_role);

  EXECUTE format('REVOKE ALL ON FUNCTION public."retain_erasure_mail_receipt"(text, text, jsonb, text, text, jsonb) FROM %I',client_role);

  EXECUTE format('REVOKE ALL ON FUNCTION public."retain_erasure_memory_binding"(text, text, jsonb, jsonb) FROM %I',client_role);

  EXECUTE format('REVOKE ALL ON FUNCTION public."retain_erasure_memory_deletion"(text, text, jsonb, jsonb) FROM %I',client_role);

  EXECUTE format('REVOKE ALL ON FUNCTION public."retain_erasure_never_hosted"(text, text, jsonb) FROM %I',client_role);

  EXECUTE format('REVOKE ALL ON FUNCTION public."retain_erasure_owner_access"(text, text, jsonb, jsonb) FROM %I',client_role);

  EXECUTE format('REVOKE ALL ON FUNCTION public."retain_erasure_owner_access_checkpoint"(text, text, jsonb, jsonb) FROM %I',client_role);

  EXECUTE format('REVOKE ALL ON FUNCTION public."retain_erasure_repository_grant_receipt"(text, text, jsonb, text, jsonb) FROM %I',client_role);

  EXECUTE format('REVOKE ALL ON FUNCTION public."retain_erasure_repository_inventory"(text, text, jsonb, jsonb) FROM %I',client_role);

  EXECUTE format('REVOKE ALL ON FUNCTION public."retain_erasure_repository_retention"(text, text, jsonb, jsonb) FROM %I',client_role);

  EXECUTE format('REVOKE ALL ON FUNCTION public."retain_erasure_runtime_grant_receipt"(text, text, jsonb, text, jsonb) FROM %I',client_role);

  EXECUTE format('REVOKE ALL ON FUNCTION public."retain_erasure_secret_receipt"(text, text, jsonb, text, jsonb) FROM %I',client_role);

  EXECUTE format('REVOKE ALL ON FUNCTION public."retain_erasure_substrate_inventory"(text, text, jsonb) FROM %I',client_role);

  EXECUTE format('REVOKE ALL ON FUNCTION public."retain_erasure_upgrade_ack"(text, text, jsonb) FROM %I',client_role);

  EXECUTE format('REVOKE ALL ON FUNCTION public."retain_erasure_writer_receipt"(text, text, jsonb, text, jsonb) FROM %I',client_role);

  EXECUTE format('REVOKE ALL ON FUNCTION public."retain_personal_agent_provision_ack"(text, jsonb) FROM %I',client_role);

  EXECUTE format('REVOKE ALL ON FUNCTION public."retire_superseded_pod_signing_key"() FROM %I',client_role);

  EXECUTE format('REVOKE ALL ON FUNCTION public."valid_azure_arm_acknowledgement"(jsonb, text) FROM %I',client_role);

  EXECUTE format('REVOKE ALL ON FUNCTION public."valid_azure_browser_update_approval"(jsonb, jsonb) FROM %I',client_role);

  EXECUTE format('REVOKE ALL ON FUNCTION public."valid_azure_cleanup_authorization_append"(text, jsonb, jsonb) FROM %I',client_role);

  EXECUTE format('REVOKE ALL ON FUNCTION public."valid_azure_erasure_append"(text, jsonb, jsonb) FROM %I',client_role);

  EXECUTE format('REVOKE ALL ON FUNCTION public."valid_azure_erasure_plan"(text, jsonb) FROM %I',client_role);

  EXECUTE format('REVOKE ALL ON FUNCTION public."valid_azure_retention_receipt"(jsonb, text, jsonb) FROM %I',client_role);

  EXECUTE format('REVOKE ALL ON FUNCTION public."valid_azure_vm_power_event"(jsonb, jsonb) FROM %I',client_role);

  EXECUTE format('REVOKE ALL ON FUNCTION public."valid_byoc_azure_hosted_intent"(text, text, text, text, jsonb) FROM %I',client_role);

  EXECUTE format('REVOKE ALL ON FUNCTION public."valid_byoc_azure_hosted_request"(jsonb, jsonb, text) FROM %I',client_role);

  EXECUTE format('REVOKE ALL ON FUNCTION public."valid_byoc_azure_setup_intent"(text, text, text, text, jsonb) FROM %I',client_role);

  EXECUTE format('REVOKE ALL ON FUNCTION public."valid_byoc_azure_vm_upgrade_intent"(text, text, text, text, jsonb) FROM %I',client_role);

  EXECUTE format('REVOKE ALL ON FUNCTION public."valid_byoc_azure_worker_event"(text, text, jsonb, jsonb, text, text) FROM %I',client_role);

  EXECUTE format('REVOKE ALL ON FUNCTION public."valid_erasure_account_append"(jsonb, jsonb) FROM %I',client_role);

  EXECUTE format('REVOKE ALL ON FUNCTION public."valid_erasure_account_receipt"(jsonb, text, jsonb) FROM %I',client_role);

  EXECUTE format('REVOKE ALL ON FUNCTION public."valid_erasure_azure_files_upgrade_observation"(jsonb, jsonb) FROM %I',client_role);

  EXECUTE format('REVOKE ALL ON FUNCTION public."valid_erasure_bootstrap_append"(jsonb, jsonb) FROM %I',client_role);

  EXECUTE format('REVOKE ALL ON FUNCTION public."valid_erasure_bucket_append"(jsonb, jsonb) FROM %I',client_role);

  EXECUTE format('REVOKE ALL ON FUNCTION public."valid_erasure_bucket_receipt"(jsonb, text, jsonb) FROM %I',client_role);

  EXECUTE format('REVOKE ALL ON FUNCTION public."valid_erasure_compute_append"(jsonb, jsonb) FROM %I',client_role);

  EXECUTE format('REVOKE ALL ON FUNCTION public."valid_erasure_compute_receipt"(jsonb, text, jsonb) FROM %I',client_role);

  EXECUTE format('REVOKE ALL ON FUNCTION public."valid_erasure_files_append"(jsonb, jsonb) FROM %I',client_role);

  EXECUTE format('REVOKE ALL ON FUNCTION public."valid_erasure_files_receipt"(jsonb, text, text, jsonb) FROM %I',client_role);

  EXECUTE format('REVOKE ALL ON FUNCTION public."valid_erasure_files_upgrade_observation"(jsonb, jsonb) FROM %I',client_role);

  EXECUTE format('REVOKE ALL ON FUNCTION public."valid_erasure_gcp_files_upgrade_observation"(jsonb, jsonb) FROM %I',client_role);

  EXECUTE format('REVOKE ALL ON FUNCTION public."valid_erasure_grant_release"(jsonb, jsonb) FROM %I',client_role);

  EXECUTE format('REVOKE ALL ON FUNCTION public."valid_erasure_kms_append"(jsonb, jsonb) FROM %I',client_role);

  EXECUTE format('REVOKE ALL ON FUNCTION public."valid_erasure_kms_receipt"(jsonb, text, jsonb) FROM %I',client_role);

  EXECUTE format('REVOKE ALL ON FUNCTION public."valid_erasure_mail_append"(jsonb, jsonb) FROM %I',client_role);

  EXECUTE format('REVOKE ALL ON FUNCTION public."valid_erasure_mail_receipt"(jsonb, text, text, jsonb) FROM %I',client_role);

  EXECUTE format('REVOKE ALL ON FUNCTION public."valid_erasure_memory_binding"(jsonb, jsonb) FROM %I',client_role);

  EXECUTE format('REVOKE ALL ON FUNCTION public."valid_erasure_memory_deletion"(jsonb, jsonb) FROM %I',client_role);

  EXECUTE format('REVOKE ALL ON FUNCTION public."valid_erasure_never_hosted_append"(text, jsonb, jsonb) FROM %I',client_role);

  EXECUTE format('REVOKE ALL ON FUNCTION public."valid_erasure_notification_observation"(jsonb, jsonb) FROM %I',client_role);

  EXECUTE format('REVOKE ALL ON FUNCTION public."valid_erasure_owner_access"(jsonb, jsonb) FROM %I',client_role);

  EXECUTE format('REVOKE ALL ON FUNCTION public."valid_erasure_owner_access_checkpoint"(jsonb, jsonb) FROM %I',client_role);

  EXECUTE format('REVOKE ALL ON FUNCTION public."valid_erasure_provision_ack"(jsonb, jsonb) FROM %I',client_role);

  EXECUTE format('REVOKE ALL ON FUNCTION public."valid_erasure_repository_grant_append"(jsonb, jsonb) FROM %I',client_role);

  EXECUTE format('REVOKE ALL ON FUNCTION public."valid_erasure_repository_grant_receipt"(jsonb, text, jsonb) FROM %I',client_role);

  EXECUTE format('REVOKE ALL ON FUNCTION public."valid_erasure_repository_inventory"(jsonb, jsonb) FROM %I',client_role);

  EXECUTE format('REVOKE ALL ON FUNCTION public."valid_erasure_repository_retention"(jsonb, jsonb) FROM %I',client_role);

  EXECUTE format('REVOKE ALL ON FUNCTION public."valid_erasure_runtime_grant_append"(jsonb, jsonb) FROM %I',client_role);

  EXECUTE format('REVOKE ALL ON FUNCTION public."valid_erasure_runtime_grant_receipt"(jsonb, text, jsonb) FROM %I',client_role);

  EXECUTE format('REVOKE ALL ON FUNCTION public."valid_erasure_secret_append"(jsonb, jsonb) FROM %I',client_role);

  EXECUTE format('REVOKE ALL ON FUNCTION public."valid_erasure_secret_receipt"(jsonb, text, jsonb) FROM %I',client_role);

  EXECUTE format('REVOKE ALL ON FUNCTION public."valid_erasure_substrate_inventory"(jsonb, jsonb) FROM %I',client_role);

  EXECUTE format('REVOKE ALL ON FUNCTION public."valid_erasure_upgrade_ack"(jsonb, jsonb) FROM %I',client_role);

  EXECUTE format('REVOKE ALL ON FUNCTION public."valid_erasure_writer_append"(jsonb, jsonb) FROM %I',client_role);

  EXECUTE format('REVOKE ALL ON FUNCTION public."valid_erasure_writer_receipt"(jsonb, text, jsonb) FROM %I',client_role);

  EXECUTE format('REVOKE ALL ON FUNCTION public."valid_gcp_browser_update_approval"(jsonb, jsonb) FROM %I',client_role);

  EXECUTE format('REVOKE ALL ON FUNCTION public."valid_personal_agent_notification_checkpoint"(jsonb, jsonb, jsonb) FROM %I',client_role);

  EXECUTE format('REVOKE ALL ON FUNCTION public."valid_pod_upgrade_cursor"(jsonb) FROM %I',client_role);

  EXECUTE format('REVOKE ALL ON FUNCTION public."verify_erasure_account_preflight"(text, text, jsonb) FROM %I',client_role);

  EXECUTE format('REVOKE ALL ON FUNCTION public."verify_erasure_bucket_preflight"(text, text, jsonb) FROM %I',client_role);

  EXECUTE format('REVOKE ALL ON FUNCTION public."verify_erasure_files_preflight"(text, text, jsonb) FROM %I',client_role);

  EXECUTE format('REVOKE ALL ON FUNCTION public."verify_erasure_kms_preflight"(text, text, jsonb) FROM %I',client_role);

  EXECUTE format('REVOKE ALL ON FUNCTION public."verify_erasure_mail_preflight"(text, text, jsonb) FROM %I',client_role);

  EXECUTE format('REVOKE ALL ON FUNCTION public."verify_erasure_owner_access_preflight"(text, text, jsonb) FROM %I',client_role);

  EXECUTE format('REVOKE ALL ON FUNCTION public."verify_erasure_secret_preflight"(text, text, jsonb) FROM %I',client_role);

  EXECUTE format('REVOKE ALL ON SEQUENCE public.%I FROM %I','agent_prompt_versions_id_seq',client_role);

  EXECUTE format('REVOKE ALL ON SEQUENCE public.%I FROM %I','consent_audit_receipts_id_seq',client_role);

  EXECUTE format('REVOKE ALL ON SEQUENCE public.%I FROM %I','personal_agent_deletion_tombstones_id_seq',client_role);

  EXECUTE format('REVOKE ALL ON SEQUENCE public.%I FROM %I','webauthn_challenges_id_seq',client_role);

  EXECUTE format('REVOKE ALL ON SEQUENCE public.%I FROM %I','webauthn_credentials_id_seq',client_role);

 END LOOP;
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN

  GRANT SELECT,INSERT,UPDATE,DELETE ON TABLE public."account_deletion_tombstones" TO service_role;

  GRANT SELECT,INSERT,UPDATE,DELETE ON TABLE public."agent_prompt_versions" TO service_role;

  GRANT SELECT,INSERT,UPDATE,DELETE ON TABLE public."byoc_setup_jobs" TO service_role;

  GRANT SELECT,INSERT,UPDATE,DELETE ON TABLE public."consent_audit" TO service_role;

  GRANT SELECT,INSERT,UPDATE,DELETE ON TABLE public."consent_audit_receipts" TO service_role;

  GRANT SELECT,INSERT,UPDATE,DELETE ON TABLE public."one_action_directive_ledger" TO service_role;

  GRANT SELECT,INSERT,UPDATE,DELETE ON TABLE public."personal_agent_cloud_removals" TO service_role;

  GRANT SELECT,INSERT,UPDATE,DELETE ON TABLE public."personal_agent_deletion_tombstones" TO service_role;

  GRANT SELECT,INSERT,UPDATE,DELETE ON TABLE public."personal_agent_registry" TO service_role;

  GRANT SELECT,INSERT,UPDATE,DELETE ON TABLE public."personal_agent_standby_placements" TO service_role;

  GRANT SELECT,INSERT,UPDATE,DELETE ON TABLE public."pod_lifecycle_events" TO service_role;

  GRANT SELECT,INSERT,UPDATE,DELETE ON TABLE public."pod_migration_jobs" TO service_role;

  GRANT SELECT,INSERT,UPDATE,DELETE ON TABLE public."pod_request_nonces" TO service_role;

  GRANT SELECT,INSERT,UPDATE,DELETE ON TABLE public."shared_files_storage" TO service_role;

  GRANT SELECT,INSERT,UPDATE,DELETE ON TABLE public."webauthn_challenges" TO service_role;

  GRANT SELECT,INSERT,UPDATE,DELETE ON TABLE public."webauthn_credentials" TO service_role;

  GRANT USAGE,SELECT ON SEQUENCE public."agent_prompt_versions_id_seq" TO service_role;

  GRANT USAGE,SELECT ON SEQUENCE public."consent_audit_receipts_id_seq" TO service_role;

  GRANT USAGE,SELECT ON SEQUENCE public."personal_agent_deletion_tombstones_id_seq" TO service_role;

  GRANT USAGE,SELECT ON SEQUENCE public."webauthn_challenges_id_seq" TO service_role;

  GRANT USAGE,SELECT ON SEQUENCE public."webauthn_credentials_id_seq" TO service_role;

 END IF;
END
$custody_acl$;

SET LOCAL check_function_bodies=on;

DO $revalidate$
DECLARE f record;
BEGIN
 FOR f IN SELECT p.oid FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace JOIN pg_language l ON l.oid=p.prolang WHERE n.nspname='public' AND l.lanname='sql' AND p.proname IN ('approve_azure_erasure_plan','approve_personal_agent_cloud_removal','assert_azure_erasure_worker','assert_project_grant_admission','azure_account_cleanup_ready','azure_browser_update_admission_ready','azure_cleanup_candidate_digest','azure_cleanup_cloud_purpose_authorized','azure_cleanup_information_erased','azure_erasure_absence_settled','azure_erasure_authorization','azure_erasure_context','azure_erasure_execution_receipt','azure_erasure_request_retryable','azure_erasure_resources_complete','azure_erasure_setup_history','azure_erasure_writers_drained','azure_files_upgrade_admission_ready','azure_setup_never_deployed','azure_setup_no_effects','azure_setup_predeployment_proven','azure_vm_image_publication_proven','azure_vm_power_binding','azure_vm_power_eligible','azure_vm_power_pending','azure_vm_power_phase_proven','azure_vm_upgrade_dispatch_settled','azure_vm_upgrade_recovery_intent','azure_vm_upgrade_registry_binding','begin_azure_erasure_worker','begin_byoc_azure_worker','begin_byoc_azure_worker','block_unattempted_azure_vm_upgrade','browser_update_admission_ready','byoc_azure_files_request_admitted','byoc_azure_intent_admitted','byoc_azure_live_worker_admitted','byoc_azure_setup_guards_ready','byoc_azure_vm_upgrade_admitted','byoc_azure_vm_upgrade_request_ready','byoc_azure_worker_admitted','byoc_azure_worker_history_has_capacity','byoc_azure_worker_session_held','claim_personal_agent_provision','effective_erasure_azure_files_inventory','effective_erasure_substrate_inventory','erasure_mail_resource_state','erasure_mail_resources_deleted','erasure_never_hosted_admitted','erasure_planned_resources_covered','erasure_provider_revocation_complete','erasure_runtime_grants_complete','expected_erasure_bootstrap_release','expected_erasure_never_hosted','files_upgrade_admission_ready','finalize_personal_agent_cloud_removal','finalize_personal_agent_erasure','guard_azure_vm_power_deletion','guard_azure_vm_power_registry','guard_azure_vm_power_standby','guard_byoc_authorization_attempts','guard_byoc_azure_erasure_job','guard_personal_agent_cloud_removal','guard_personal_agent_cloud_removal_history','guard_personal_agent_erasure_archive','guard_personal_agent_erasure_grant','guard_personal_agent_erasure_registry','guard_personal_agent_notification_registry','guard_personal_agent_notification_retention','guard_personal_agent_notification_standby_retention','guard_personal_agent_provision_registry','guard_personal_agent_renewal','guard_personal_agent_standby_placement','guard_project_grant_registry_admission','guard_project_grant_setup_admission','insert_personal_agent_renewal','notification_checkpoint_admission_ready','notification_checkpoint_inventory','notification_erasure_custody_archived','notification_initial_host_binding','notification_placement_custody','operator_mail_grants_qualified','operator_notification_custody_ready','operator_topic_custody_preserved','personal_agent_cloud_removal_covers','personal_agent_cloud_removal_execute_ready','personal_agent_cloud_removal_identity','personal_agent_cloud_removal_ready','personal_agent_cloud_removal_replay_current','personal_agent_cloud_removal_review','personal_agent_cloud_removed','personal_agent_erasure_archive','personal_agent_erasure_archived','personal_agent_erasure_complete','pod_lifecycle_notify','project_grant_release_is_exclusive','publish_personal_agent_notification_checkpoint','publish_personal_agent_provision','reserve_azure_account_cleanup','reserve_erasure_bootstrap_grants','reserve_erasure_grant_release','reserve_personal_agent_cloud_removal','reserve_personal_agent_erasure','restore_personal_agent_erasure_reservation','retain_azure_cleanup_authorization_outcome','retain_azure_erasure_execution_receipt','retain_azure_erasure_state','retain_byoc_authorization','retain_byoc_azure_setup_intent','retain_byoc_azure_worker_event','retain_erasure_account_receipt','retain_erasure_bootstrap_grant_receipt','retain_erasure_bucket_receipt','retain_erasure_compute_receipt','retain_erasure_files_receipt','retain_erasure_files_upgrade_observation','retain_erasure_kms_receipt','retain_erasure_mail_receipt','retain_erasure_memory_binding','retain_erasure_memory_deletion','retain_erasure_never_hosted','retain_erasure_owner_access','retain_erasure_owner_access_checkpoint','retain_erasure_repository_grant_receipt','retain_erasure_repository_inventory','retain_erasure_repository_retention','retain_erasure_runtime_grant_receipt','retain_erasure_secret_receipt','retain_erasure_substrate_inventory','retain_erasure_upgrade_ack','retain_erasure_writer_receipt','retain_personal_agent_provision_ack','retire_superseded_pod_signing_key','valid_azure_arm_acknowledgement','valid_azure_browser_update_approval','valid_azure_cleanup_authorization_append','valid_azure_erasure_append','valid_azure_erasure_plan','valid_azure_retention_receipt','valid_azure_vm_power_event','valid_byoc_azure_hosted_intent','valid_byoc_azure_hosted_request','valid_byoc_azure_setup_intent','valid_byoc_azure_vm_upgrade_intent','valid_byoc_azure_worker_event','valid_erasure_account_append','valid_erasure_account_receipt','valid_erasure_azure_files_upgrade_observation','valid_erasure_bootstrap_append','valid_erasure_bucket_append','valid_erasure_bucket_receipt','valid_erasure_compute_append','valid_erasure_compute_receipt','valid_erasure_files_append','valid_erasure_files_receipt','valid_erasure_files_upgrade_observation','valid_erasure_gcp_files_upgrade_observation','valid_erasure_grant_release','valid_erasure_kms_append','valid_erasure_kms_receipt','valid_erasure_mail_append','valid_erasure_mail_receipt','valid_erasure_memory_binding','valid_erasure_memory_deletion','valid_erasure_never_hosted_append','valid_erasure_notification_observation','valid_erasure_owner_access','valid_erasure_owner_access_checkpoint','valid_erasure_provision_ack','valid_erasure_repository_grant_append','valid_erasure_repository_grant_receipt','valid_erasure_repository_inventory','valid_erasure_repository_retention','valid_erasure_runtime_grant_append','valid_erasure_runtime_grant_receipt','valid_erasure_secret_append','valid_erasure_secret_receipt','valid_erasure_substrate_inventory','valid_erasure_upgrade_ack','valid_erasure_writer_append','valid_erasure_writer_receipt','valid_gcp_browser_update_approval','valid_personal_agent_notification_checkpoint','valid_pod_upgrade_cursor','verify_erasure_account_preflight','verify_erasure_bucket_preflight','verify_erasure_files_preflight','verify_erasure_kms_preflight','verify_erasure_mail_preflight','verify_erasure_owner_access_preflight','verify_erasure_secret_preflight') LOOP
  EXECUTE pg_get_functiondef(f.oid);
 END LOOP;
END
$revalidate$;
COMMIT;
