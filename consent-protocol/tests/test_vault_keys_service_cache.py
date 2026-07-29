# tests/test_vault_keys_service_cache.py
"""
Canonical attach point:
  hushh_mcp.services.vault_keys_service.VaultKeysService
  -> api.routes.db_proxy -> POST /api/db-proxy/vault/status

Proves that two separate VaultKeysService() instances share the same
class-level cache, so a value written by one instance is readable from
a second instance (simulating per-request instantiation).
"""

from hushh_mcp.services.vault_keys_service import VaultKeysService


class TestVaultKeysServiceCacheShared:
    """_vault_state_cache must be class-level and shared across instances."""

    def setup_method(self):
        # Start each test with a clean cache to avoid cross-test pollution.
        VaultKeysService._vault_state_cache.clear()

    def test_cache_is_class_attribute(self):
        svc = VaultKeysService()
        # The instance must NOT have its own copy of _vault_state_cache.
        assert "_vault_state_cache" not in svc.__dict__, (
            "_vault_state_cache must be a class attribute, not an instance attribute"
        )

    def test_two_instances_share_cache(self):
        svc_a = VaultKeysService()
        svc_b = VaultKeysService()

        # Write via instance A.
        svc_a._set_cached_vault_state("user-123", {"vaultKeyHash": "abc"})

        # Read via instance B -- must see the cached value without a DB hit.
        cached = svc_b._get_cached_vault_state("user-123")
        assert cached is not None, "Instance B must see cache written by instance A"
        assert cached["vaultKeyHash"] == "abc"

    def test_invalidation_visible_across_instances(self):
        svc_a = VaultKeysService()
        svc_b = VaultKeysService()

        svc_a._set_cached_vault_state("user-456", {"vaultKeyHash": "xyz"})
        svc_b._invalidate_vault_state_cache("user-456")

        # After invalidation by B, A must also see the cache as empty.
        cached = svc_a._get_cached_vault_state("user-456")
        assert cached is None, "Invalidation by one instance must be visible to all instances"
