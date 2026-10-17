"""Hermetic tests for the prompt-sync repo + service (read path).

A tiny in-memory fake stands in for the Supabase client and implements just the
fluent operations the repo uses (table/select/eq/limit/execute) with real
filtering semantics, so the real ``PersonalAgentPromptRepo`` select-chain is
exercised without a database. The service is verified for its two integrity
guarantees: a freshly recomputed SHA-256 (never the stored one) and a
deterministic, verifiable HMAC signature that is bound to the prompt content.
"""

from __future__ import annotations

import hashlib
from types import SimpleNamespace

import pytest

from hushh_mcp.runtime_settings import get_core_security_settings
from hushh_mcp.services.personal_agent_prompt_repo import PersonalAgentPromptRepo
from hushh_mcp.services.personal_agent_prompt_service import (
    DEFAULT_CHANNEL,
    PersonalAgentPromptService,
    compute_prompt_sha256,
    sign_prompt,
    verify_prompt_signature,
)

_TABLE = "agent_prompt_versions"


@pytest.fixture(autouse=True)
def _env(monkeypatch):
    monkeypatch.setenv("APP_SIGNING_KEY", "test_secret_key_for_ci_only_32chars_min")
    monkeypatch.setenv("VAULT_DATA_KEY", "0" * 64)
    get_core_security_settings.cache_clear()
    yield
    get_core_security_settings.cache_clear()


class _Query:
    def __init__(self, db, table):
        self._db = db
        self._table = table
        self._eqs: list[tuple[str, object]] = []
        self._limit = None

    def select(self, _cols="*"):
        return self

    def eq(self, col, val):
        self._eqs.append((col, val))
        return self

    def limit(self, n):
        self._limit = n
        return self

    def execute(self):
        rows = self._db.tables.get(self._table, [])
        out = [r for r in rows if all(r.get(c) == v for c, v in self._eqs)]
        if self._limit is not None:
            out = out[: self._limit]
        return SimpleNamespace(data=out)


class FakeDB:
    def __init__(self):
        self.tables: dict[str, list[dict]] = {}

    def table(self, name):
        return _Query(self, name)

    def seed(self, **row):
        self.tables.setdefault(_TABLE, []).append(dict(row))


def _row(
    *,
    agent_id="personal_agent",
    channel="default",
    version="v1",
    text="be helpful",
    status="active",
):
    return {
        "agent_id": agent_id,
        "channel": channel,
        "version": version,
        "prompt_text": text,
        "prompt_sha256": "stale-hash-should-be-ignored",
        "status": status,
    }


def _svc(db):
    return PersonalAgentPromptService(repo=PersonalAgentPromptRepo(client=db))


# ---- repo ------------------------------------------------------------------


async def test_repo_get_active_returns_active_row():
    db = FakeDB()
    db.seed(**_row(version="v3", text="hello"))
    repo = PersonalAgentPromptRepo(client=db)
    row = await repo.get_active("personal_agent", "default")
    assert row is not None
    assert row["version"] == "v3"


async def test_repo_ignores_non_active_rows():
    db = FakeDB()
    db.seed(**_row(version="v1", status="retired"))
    db.seed(**_row(version="v2", status="canary"))
    repo = PersonalAgentPromptRepo(client=db)
    assert await repo.get_active("personal_agent", "default") is None


async def test_repo_scopes_by_channel():
    db = FakeDB()
    db.seed(**_row(channel="voice", version="voice-1"))
    repo = PersonalAgentPromptRepo(client=db)
    assert await repo.get_active("personal_agent", "default") is None
    row = await repo.get_active("personal_agent", "voice")
    assert row is not None and row["version"] == "voice-1"


# ---- service ---------------------------------------------------------------


async def test_service_recomputes_sha_and_signs():
    db = FakeDB()
    db.seed(**_row(version="v7", text="stay private"))
    resolved = await _svc(db).get_active_prompt(agent_id="personal_agent")

    assert resolved is not None
    assert resolved.version == "v7"
    assert resolved.prompt_text == "stay private"
    # The returned hash is recomputed from the text, NOT the stale stored one.
    assert resolved.prompt_sha256 == hashlib.sha256(b"stay private").hexdigest()
    assert resolved.prompt_sha256 != "stale-hash-should-be-ignored"
    # The signature verifies against the recomputed identity.
    assert verify_prompt_signature(
        resolved.agent_id,
        resolved.channel,
        resolved.version,
        resolved.prompt_sha256,
        resolved.signature,
    )


async def test_service_missing_returns_none():
    db = FakeDB()
    assert await _svc(db).get_active_prompt(agent_id="personal_agent") is None


async def test_service_empty_agent_id_raises():
    db = FakeDB()
    with pytest.raises(ValueError):
        await _svc(db).get_active_prompt(agent_id="   ")


async def test_service_blank_channel_falls_back_to_default():
    db = FakeDB()
    db.seed(**_row(channel=DEFAULT_CHANNEL, version="d1"))
    resolved = await _svc(db).get_active_prompt(agent_id="personal_agent", channel="")
    assert resolved is not None
    assert resolved.channel == DEFAULT_CHANNEL


# ---- signature primitives --------------------------------------------------


def test_signature_prefixed_and_deterministic():
    a = sign_prompt("personal_agent", "default", "v1", compute_prompt_sha256("x"))
    b = sign_prompt("personal_agent", "default", "v1", compute_prompt_sha256("x"))
    assert a == b
    assert a.startswith("aps1_")


def test_signature_changes_with_content():
    sig_a = sign_prompt("personal_agent", "default", "v1", compute_prompt_sha256("a"))
    sig_b = sign_prompt("personal_agent", "default", "v1", compute_prompt_sha256("b"))
    assert sig_a != sig_b
    # A body swapped under a fixed (agent, channel, version) fails verification.
    assert not verify_prompt_signature(
        "personal_agent", "default", "v1", compute_prompt_sha256("b"), sig_a
    )


def test_compute_sha256_matches_hashlib():
    assert compute_prompt_sha256("hello") == hashlib.sha256(b"hello").hexdigest()
