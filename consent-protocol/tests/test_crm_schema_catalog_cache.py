from datetime import datetime, timedelta, timezone

from hushh_mcp.services.crm_schema_catalog_cache import (
    CrmSchemaCatalogCache,
    schema_fingerprint,
)


class _Result:
    def __init__(self, data):
        self.data = data


class _Db:
    def __init__(self, row=None):
        self.row = row
        self.calls = []

    def execute_raw(self, sql, params=None):
        self.calls.append((sql, params or {}))
        if "SELECT schema_fingerprint" in sql:
            return _Result([self.row] if self.row else [])
        return _Result([])


def test_schema_fingerprint_changes_only_with_normalized_schema_contract():
    first = {"objectType": "Person", "fields": [{"key": "Email"}], "target": "ignored"}
    second = {"target": "different", "fields": [{"key": "Email"}], "objectType": "Person"}
    changed = {"objectType": "Person", "fields": [{"key": "Phone"}]}

    assert schema_fingerprint(first) == schema_fingerprint(second)
    assert schema_fingerprint(first) != schema_fingerprint(changed)


def test_cache_returns_stale_catalogue_with_explicit_freshness():
    now = datetime.now(timezone.utc)
    db = _Db(
        {
            "schema_fingerprint": "fingerprint",
            "schema_json": {"objectType": "Person", "fields": []},
            "refreshed_at": now - timedelta(days=2),
            "fresh_until": now - timedelta(days=1),
            "stale_until": now + timedelta(days=5),
        }
    )

    cached = CrmSchemaCatalogCache(db).get(
        crm_id="crm-1", object_type="Person", configuration_revision=3
    )

    assert cached is not None
    assert cached["freshness"] == "stale"
    assert cached["schemaFingerprint"] == "fingerprint"
