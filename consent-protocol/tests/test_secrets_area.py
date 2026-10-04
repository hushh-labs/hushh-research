"""The Secrets area: shared patterns, the server's second net, and sharing.

Founder decisions (2026-10-01): API keys, passwords, tokens and private keys are
saved in a reserved Secrets area and are never sent to a model; One knows only
that an item exists, by its label. Card and government id numbers are held
there too. Non-secret technical ids (env var NAMES, project ids, OAuth URLs)
are ordinary work context. Sharing is a per-item grant the owner starts.

Each test guards one boundary and fails on the code before this release.
"""

from __future__ import annotations

import json
from dataclasses import fields
from pathlib import Path
from types import SimpleNamespace

import pytest
from fastapi import HTTPException

from api.routes.pkm_routes_shared import _enforce_secrets_write_policy
from hushh_mcp.consent.pkm_scope_policy import (
    is_external_requestable_pkm_scope,
    is_owner_item_grant_scope,
    is_private_pkm_export_scope,
    is_reserved_domain_scope,
)
from hushh_mcp.consent.secret_patterns import SecretSpan, find_secret_spans
from hushh_mcp.services.domain_contracts import (
    DOMAIN_SHARING_POLICY_REGISTRY,
    validate_dynamic_top_level_domain,
)
from hushh_mcp.services.secrets_domain_validation import validate_secrets_summary_envelope

BACKEND_ROOT = Path(__file__).resolve().parents[1]
REPO_ROOT = BACKEND_ROOT.parent
CONTRACT = Path("contracts", "pkm", "secret-patterns.v1.json")


def _contract() -> dict:
    return json.loads((REPO_ROOT / CONTRACT).read_text(encoding="utf-8"))


def test_all_three_contract_copies_are_identical() -> None:
    canonical = (REPO_ROOT / CONTRACT).read_bytes()
    for mirror in (BACKEND_ROOT / CONTRACT, REPO_ROOT / "hushh-webapp" / CONTRACT):
        assert mirror.read_bytes() == canonical, mirror


def test_every_shared_case_matches_on_the_server() -> None:
    """The device runs the same cases; a regex that compiles differently fails here."""
    cases = _contract()["cases"]
    assert any(case["expect"] for case in cases) and any(not case["expect"] for case in cases)
    wrong = []
    for case in cases:
        text = "".join(case["parts"])
        found = [(span.pattern_id, text[span.start : span.end]) for span in find_secret_spans(text)]
        expected = [(item["id"], "".join(item["value"])) for item in case["expect"]]
        if found != expected:
            wrong.append((case["why"], found, expected))
    assert wrong == []


def test_env_var_names_and_plain_urls_are_not_secrets() -> None:
    for text in (
        "Set STRIPE_SECRET_KEY and GITHUB_TOKEN in Secret Manager",
        "OPENAI_API_KEY=${OPENAI_API_KEY}",
        "https://console.cloud.google.com/run?project=hushh-pda-dev",
        "redirect to https://app.example.test/oauth/callback?state=abc",
    ):
        assert find_secret_spans(text) == (), text


def test_the_server_net_reports_where_and_what_never_the_value() -> None:
    value = "".join(["gh", "p_", "fakefake0000fakefake0000fakefake0000"])
    text = f"my token {value} please"
    (span,) = find_secret_spans(text)
    assert {field.name for field in fields(SecretSpan)} == {
        "start",
        "end",
        "kind",
        "pattern_id",
        "file_to",
    }
    assert (span.kind, span.pattern_id) == ("credential", "github_token")
    assert text[span.start : span.end] == value
    assert value not in repr(span)


def test_card_and_government_ids_name_where_the_owner_may_file_them() -> None:
    card = find_secret_spans("card 4111 1111 1111 1111")[0]
    passport = find_secret_spans("passport number X1234567")[0]
    api_key = find_secret_spans("api_key: fake0000fake")[0]
    assert (card.kind, card.file_to) == ("card_number", "wallet")
    assert (passport.kind, passport.file_to) == ("government_id", "kyc_identity_documents")
    assert api_key.file_to == "none"


def test_a_placeholder_already_in_the_text_is_never_found_again() -> None:
    assert find_secret_spans("saved ⟦secret:sec_00000000000000ab Password⟧ ok") == ()


# --- the reserved domain and its sharing policy ---


def test_nl_structuring_cannot_invent_the_secrets_domain() -> None:
    with pytest.raises(ValueError, match="owner_managed_domain_slug"):
        validate_dynamic_top_level_domain("secrets")
    assert validate_dynamic_top_level_domain("secrets", allow_internal=True) == "secrets"
    assert is_reserved_domain_scope("attr.secrets.items.sec_00000000000000ab")


@pytest.mark.parametrize(
    "scope",
    [
        "attr.secrets.*",
        "attr.secrets.items.*",
        "attr.secrets.items",
        "attr.secrets.items.sec_00000000000000ab",
        "attr.secrets.items.sec_00000000000000ab.value",
    ],
)
def test_nothing_in_secrets_is_requestable_and_nothing_exports(scope: str) -> None:
    assert not is_external_requestable_pkm_scope(scope)
    assert is_private_pkm_export_scope(scope)


@pytest.mark.parametrize(
    ("scope", "expected"),
    [
        ("attr.secrets.items.sec_00000000000000ab", True),
        ("attr.secrets.items.*", False),
        ("attr.secrets.*", False),
        ("attr.secrets.items", False),
        ("attr.secrets.items.sec_00000000000000ab.value", False),
        ("attr.secrets.items.card_1", False),
        ("attr.secrets.labels.sec_00000000000000ab", False),
        ("attr.wallet.secrets.sec_00000000000000ab", False),
        ("attr.food.items.sec_00000000000000ab", False),
        (None, False),
    ],
)
def test_per_item_grant_scope_shape(scope: str | None, expected: bool) -> None:
    assert is_owner_item_grant_scope(scope) is expected


def test_secrets_policy_declares_owner_started_per_item_grants_only() -> None:
    policy = DOMAIN_SHARING_POLICY_REGISTRY["secrets"]
    assert policy.allow_domain_wildcard is False
    assert policy.requestable_scopes == frozenset()
    assert policy.allow_public_projection is False
    assert policy.per_item_grant_branch == "items"


# --- the plaintext summary beside the ciphertext ---


def test_a_bookkeeping_summary_is_accepted() -> None:
    validate_secrets_summary_envelope(
        {
            "domain_intent": "secrets",
            "item_count": 3,
            "storage_mode": "encrypted_domain",
            "consumer_visible": False,
            "pkm_contract_version": "6.0.0",
            "upgraded_at": "2026-10-01T03:12:00.000Z",
        }
    )


@pytest.mark.parametrize(
    "summary",
    [
        {"items": {"sec_00000000000000ab": {"label": "GitHub token ending 0000"}}},
        {"labels": ["Password"]},
        {"note": "GitHub token ending 0000"},
        {"latest": "".join(["sk", "_live_", "fakefake0000fakefake"])},
        {"item_count": True},
    ],
)
def test_a_summary_that_could_leak_a_secret_or_label_is_refused(summary: dict) -> None:
    with pytest.raises(ValueError):
        validate_secrets_summary_envelope(summary)
    with pytest.raises(HTTPException) as refused:
        _enforce_secrets_write_policy(SimpleNamespace(summary=summary), "secrets")
    assert refused.value.status_code == 422
    assert refused.value.detail["code"] == "SECRETS_SUMMARY_ENVELOPE_INVALID"
    # The refusal names the offending key, never the text that was refused.
    assert "0000" not in json.dumps(refused.value.detail)


def test_other_domains_are_untouched_by_the_secrets_envelope() -> None:
    _enforce_secrets_write_policy(SimpleNamespace(summary={"note": "free text"}), "notes")
