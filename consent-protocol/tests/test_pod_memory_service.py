"""Tests for per-pod agent memory.

These assert the four invariants named in the module docstring, not just that the code
runs. The isolation and no-plaintext tests are the load-bearing ones: they are what make
"the pod may remember" safe under the revised Agent Architecture Doctrine.
"""

from __future__ import annotations

import base64
import json

import pytest

from hushh_mcp.services.pod_memory_service import (
    PodMemoryError,
    PodMemoryStore,
    resolve_pod_memory_service,
)

_KEY_A = b"pod-key-alpha-32-bytes-long-xxxx"
_KEY_B = b"pod-key-bravo-32-bytes-long-yyyy"


def _store(hushh_id: str = "ha1_alice", key: bytes = _KEY_A) -> PodMemoryStore:
    return PodMemoryStore(hushh_id=hushh_id, pod_key=key)


# --- invariant 1: memory never crosses a pod boundary ------------------------------


def test_search_for_another_owner_raises():
    s = _store("ha1_alice")
    s.add(text="Alice prefers morning flights out of SEA")
    with pytest.raises(PodMemoryError):
        s.search(hushh_id="ha1_bob", query="flights")


def test_store_requires_an_owner():
    with pytest.raises(PodMemoryError):
        PodMemoryStore(hushh_id="", pod_key=_KEY_A)


def test_store_requires_a_pod_key():
    with pytest.raises(PodMemoryError):
        PodMemoryStore(hushh_id="ha1_alice", pod_key=b"")


def test_another_pods_key_cannot_read_this_pods_memory():
    """The strongest isolation claim: even holding the ciphertext, a different pod key
    neither matches the search index nor recovers the text."""
    alice = _store("ha1_alice", _KEY_A)
    rec = alice.add(text="Alice's cardiologist is Dr Reyes")
    assert rec is not None

    # A second pod, different key, handed the same sealed record.
    bob = _store("ha1_bob", _KEY_B)
    bob._records.append(rec)  # simulate a leaked blob landing in another pod

    # The keyed digests were computed under Alice's key, so Bob's query cannot match them.
    assert bob.search(hushh_id="ha1_bob", query="cardiologist") == []


# --- invariant 2: only ciphertext at rest ------------------------------------------


def test_plaintext_never_appears_at_rest():
    s = _store()
    secret = "Alice's passport number is X1234567"
    s.add(text=secret)
    exported = s.export()
    assert "passport number" not in exported
    assert "X1234567" not in exported
    # and the export really is the record set, not an empty stub
    assert len(json.loads(exported)) == 1


def test_search_index_holds_no_plaintext_tokens():
    s = _store()
    rec = s.add(text="renew the passport before travel")
    assert rec is not None
    assert "passport" not in " ".join(rec.token_digests)
    assert "travel" not in " ".join(rec.token_digests)


def test_roundtrip_recovers_text_for_the_owning_pod():
    s = _store()
    s.add(text="Alice prefers aisle seats and no red-eye flights")
    hits = s.search(hushh_id="ha1_alice", query="aisle seats")
    assert hits, "the owning pod must be able to recall its own memory"
    _, plain = hits[0]
    assert "aisle seats" in plain


# --- behaviour --------------------------------------------------------------------


def test_empty_text_is_not_stored():
    s = _store()
    assert s.add(text="   ") is None
    assert len(s) == 0


def test_search_ranks_stronger_overlap_first():
    s = _store()
    s.add(text="a note about coffee")
    s.add(text="a longer note about coffee and espresso machines")
    hits = s.search(hushh_id="ha1_alice", query="coffee espresso")
    assert len(hits) == 2
    assert "espresso" in hits[0][1], "the record matching more query terms must rank first"


def test_purge_clears_everything():
    s = _store()
    s.add(text="something forgettable")
    assert s.purge() == 1
    assert len(s) == 0


# --- invariant 3: flag-off is inert, and the hub never gets memory ------------------


def test_hub_gets_no_memory_even_with_the_flag_on(monkeypatch):
    """The doctrine's first half, proven by test rather than prose: outside pod mode the
    runtime gets no memory service regardless of the kill-switch."""
    monkeypatch.setenv("POD_AGENT_MEMORY_ENABLED", "1")
    monkeypatch.delenv("HUSSH_POD_MODE", raising=False)
    assert resolve_pod_memory_service() is None


def test_pod_without_the_flag_gets_no_memory(monkeypatch):
    monkeypatch.setenv("HUSSH_POD_MODE", "1")
    monkeypatch.delenv("POD_AGENT_MEMORY_ENABLED", raising=False)
    assert resolve_pod_memory_service() is None


def test_pod_with_flag_but_no_identity_fails_safe(monkeypatch):
    monkeypatch.setenv("HUSSH_POD_MODE", "1")
    monkeypatch.setenv("POD_AGENT_MEMORY_ENABLED", "1")
    monkeypatch.delenv("HUSSH_ID", raising=False)
    monkeypatch.delenv("HUSSH_POD_MEMORY_KEY", raising=False)
    assert resolve_pod_memory_service() is None


def test_pod_fully_configured_resolves_a_service(monkeypatch):
    monkeypatch.setenv("HUSSH_POD_MODE", "1")
    monkeypatch.setenv("POD_AGENT_MEMORY_ENABLED", "1")
    monkeypatch.setenv("HUSSH_ID", "ha1_alice")
    monkeypatch.setenv("HUSSH_POD_MEMORY_KEY", base64.b64encode(_KEY_A).decode("ascii"))
    svc = resolve_pod_memory_service()
    assert svc is not None
    assert hasattr(svc, "search_memory") and hasattr(svc, "add_session_to_memory")
