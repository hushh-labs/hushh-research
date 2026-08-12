-- Schema-only rollback. Deliberately does not restore retired profile
-- configuration: that would re-enable a runtime with no remaining implementation.

BEGIN;

ALTER TABLE enterprise_crm_registry
  DROP CONSTRAINT IF EXISTS enterprise_crm_registry_legacy_crm_zk_profiles_retired;
ALTER TABLE enterprise_crm_registry
  ADD CONSTRAINT enterprise_crm_registry_crm_zk_profile_exclusive CHECK (
    NOT (crm_zk_v1_enabled AND crm_zk_uat_v1_enabled)
  );

COMMIT;
