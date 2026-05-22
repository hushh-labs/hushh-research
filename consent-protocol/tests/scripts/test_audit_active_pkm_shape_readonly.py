import json

from scripts.audit_active_pkm_shape_readonly import (
    _resolve_sensitive_input,
    summarize_payload_shape,
)


def test_active_pkm_shape_audit_redacts_values_and_dynamic_ids():
    payload = {
        "seat_preferences": {
            "entities": {
                "travel_preference_seat_001": {
                    "entity_id": "travel_preference_seat_001",
                    "summary": "Actually window seats work better now.",
                    "observations": [
                        "I used to prefer aisle seats.",
                        "Actually window seats work better now.",
                    ],
                    "status": "active",
                    "provenance": {
                        "artifact_id": "receipt_memory_ad991461",
                        "deterministic_projection_hash": "a" * 64,
                    },
                }
            }
        },
        "profile": {
            "email": "kushaltrivedi1711@gmail.com",
            "home_city": "New York City",
        },
    }

    shape = summarize_payload_shape(payload)
    rendered = json.dumps(shape)

    assert "Actually window seats work better now" not in rendered
    assert "kushaltrivedi1711@gmail.com" not in rendered
    assert "New York City" not in rendered
    assert "travel_preference_seat_001" not in rendered
    assert "seat_preferences.entities.{item}.summary" in shape["paths"]
    assert any(item["key"] == "provenance" for item in shape["noisy_paths"])
    assert shape["entity_collections"] == [{"path": "seat_preferences.entities", "item_count": 1}]


def test_sensitive_input_resolves_env_before_secret_manager(monkeypatch):
    calls = []

    def fake_read_secret(project: str, secret_name: str, version: str = "latest") -> str:
        calls.append((project, secret_name, version))
        return "from-secret-manager"

    monkeypatch.setenv("REVIEWER_UID", "reviewer-from-env")
    monkeypatch.setattr(
        "scripts.audit_active_pkm_shape_readonly._read_gcp_secret",
        fake_read_secret,
    )

    value, source = _resolve_sensitive_input(
        "",
        ("REVIEWER_UID",),
        **{"gcp_secret_project": "hushh-pda-uat", "gcp_secret_version": "latest"},
    )

    assert value == "reviewer-from-env"
    assert source == "env"
    assert calls == []


def test_sensitive_input_can_resolve_secret_manager_without_logging_value(monkeypatch):
    calls = []

    def fake_read_secret(project: str, secret_name: str, version: str = "latest") -> str:
        calls.append((project, secret_name, version))
        return "secret-passphrase"

    monkeypatch.delenv("REVIEWER_VAULT_PASSPHRASE", raising=False)
    monkeypatch.setattr(
        "scripts.audit_active_pkm_shape_readonly._read_gcp_secret",
        fake_read_secret,
    )

    value, source = _resolve_sensitive_input(
        None,
        ("REVIEWER_VAULT_PASSPHRASE",),
        **{"gcp_secret_project": "hushh-pda-uat", "gcp_secret_version": "latest"},
    )

    assert value == "secret-passphrase"
    assert source == "secret_manager:REVIEWER_VAULT_PASSPHRASE"
    assert calls == [("hushh-pda-uat", "REVIEWER_VAULT_PASSPHRASE", "latest")]
