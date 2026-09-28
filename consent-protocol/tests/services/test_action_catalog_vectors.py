"""The action catalog's passage vectors are baked at build time and read back.

Embedding the catalog at startup cost about 70s per Cloud Run instance per
worker, and a first chat turn waited 13-50s behind it (2026-09-27). These tests
prove the runtime reads the baked file instead of embedding, and that anything
short of an exact match falls back to the old live embedding, never an error.
"""

from __future__ import annotations

import hashlib
import os
import subprocess
import sys
from pathlib import Path
from unittest.mock import Mock

import pytest

from hushh_mcp.one_adk import action_retrieval as ar
from hushh_mcp.services import action_catalog_vectors as acv
from hushh_mcp.services.action_gateway import list_action_gateway_actions
from hushh_mcp.services.embedding_client_leaf import BAKED_MODEL_DIR
from scripts.ops import bake_action_catalog_vectors as bake_script

BACKEND_ROOT = Path(__file__).resolve().parents[2]
DIM = 8


def _fake_vector(text: str) -> list[float]:
    digest = hashlib.sha256(text.encode("utf-8")).digest()
    return [(byte - 128) / 128.0 for byte in digest[:DIM]]


def _entry(action_id: str, label: str, screen: str = "home") -> dict:
    return {
        "action_id": action_id,
        "label": label,
        "meaning": f"{label} for the person",
        "execution_target": {"status": "wired"},
        "reachability": {"screens": [screen]},
    }


GATEWAY = {
    "actions": [
        _entry("settings.open", "Open settings", "home"),
        _entry("location.share", "Share location", "map"),
        _entry("email.compose", "Compose email", "home"),
        {**_entry("draft.thing", "Not wired"), "execution_target": {"status": "planned"}},
    ]
}
WIRED = [entry for entry in GATEWAY["actions"] if acv.is_wired(entry)]
BAKED = [[float(i + 1)] * DIM for i in range(len(WIRED))]


@pytest.fixture(autouse=True)
def isolated_state(monkeypatch, tmp_path):
    monkeypatch.setattr(acv, "BAKED_VECTORS_PATH", tmp_path / "action-catalog-vectors.npz")
    monkeypatch.setattr(ar, "_PASSAGE_CACHE", {"digest": None, "vectors": []})
    monkeypatch.setattr(ar, "_last_passage_source", None)
    monkeypatch.setattr(ar, "_retrieval_available", True)
    monkeypatch.setattr(ar, "_retrieval_error", None)
    acv.clear_loaded_cache()
    yield
    acv.clear_loaded_cache()


@pytest.fixture
def client(monkeypatch):
    fake = Mock()
    fake.embed_passages.side_effect = lambda passages: [_fake_vector(p) for p in passages]
    fake.embed_query.side_effect = _fake_vector
    fake.similarity.side_effect = lambda q, ps: [
        sum(a * b for a, b in zip(q, p, strict=True)) for p in ps
    ]
    monkeypatch.setattr(ar, "get_embedding_client", lambda: fake)
    return fake


def _bake(gateway: dict = GATEWAY, vectors: list[list[float]] = BAKED) -> None:
    acv.write_baked_vectors(
        acv.BAKED_VECTORS_PATH,
        digest=acv.catalog_digest(gateway),
        passages=[acv.build_passage(e) for e in gateway["actions"] if acv.is_wired(e)],
        vectors=vectors,
    )


def test_matching_baked_vectors_are_used_and_the_catalog_is_never_embedded(client):
    _bake()

    vectors = ar._ensure_passage_vectors(WIRED, GATEWAY)

    assert vectors == BAKED
    client.embed_passages.assert_not_called()
    assert ar._last_passage_source == "baked"
    # _PASSAGE_CACHE semantics are unchanged: filled once, then served from memory.
    assert ar._PASSAGE_CACHE["digest"] == acv.catalog_digest(GATEWAY)
    assert ar._PASSAGE_CACHE["vectors"] == BAKED


def test_negative_control_a_changed_catalog_ignores_the_baked_file(client):
    """Same file, one edited label: the digest moves, so the catalog is embedded live."""
    _bake()
    changed = {"actions": [dict(e) for e in GATEWAY["actions"]]}
    changed["actions"][0]["label"] = "Open preferences"
    wired = [e for e in changed["actions"] if acv.is_wired(e)]

    vectors = ar._ensure_passage_vectors(wired, changed)

    client.embed_passages.assert_called_once()
    assert vectors == [_fake_vector(acv.build_passage(e)) for e in wired]
    assert vectors != BAKED
    assert ar._last_passage_source == "live"


def test_a_different_model_revision_ignores_the_baked_file(client, monkeypatch):
    _bake()
    monkeypatch.setattr(acv, "MODEL_REVISION", "0" * 40)

    ar._ensure_passage_vectors(WIRED, GATEWAY)

    client.embed_passages.assert_called_once()
    assert ar._last_passage_source == "live"


def test_a_missing_file_embeds_live_without_error(client):
    assert not acv.BAKED_VECTORS_PATH.exists()

    vectors = ar._ensure_passage_vectors(WIRED, GATEWAY)

    client.embed_passages.assert_called_once()
    assert len(vectors) == len(WIRED)


def test_a_corrupt_file_embeds_live_without_error(client):
    acv.BAKED_VECTORS_PATH.write_bytes(b"not an npz archive")

    vectors = ar._ensure_passage_vectors(WIRED, GATEWAY)

    client.embed_passages.assert_called_once()
    assert len(vectors) == len(WIRED)


def test_a_screen_filtered_search_is_served_from_the_baked_file(client):
    """The palette narrows the catalog by screen; that subset must not embed either."""
    _bake()

    results = ar.search_actions("settings", GATEWAY, limit=5, app_runtime_state={"screen": "home"})

    client.embed_passages.assert_not_called()
    client.embed_query.assert_called_once_with("settings")
    assert {r.action_id for r in results} <= {"settings.open", "email.compose"}
    assert ar.retrieval_error() is None


def test_the_bake_writes_exactly_what_the_runtime_reads_for_the_real_catalog(
    client, monkeypatch, tmp_path
):
    """Parity: bake and runtime agree on catalog, filter, passages and digest."""
    monkeypatch.setattr(bake_script, "EmbeddingClient", lambda: client)
    output = tmp_path / "baked.npz"
    monkeypatch.setattr(acv, "BAKED_VECTORS_PATH", output)

    digest, count = bake_script.bake(output)
    client.embed_passages.reset_mock()

    gateway = {"actions": list_action_gateway_actions()}
    results = ar.search_actions("open settings", gateway, limit=3)

    assert count > 0 and digest == acv.catalog_digest(gateway)
    client.embed_passages.assert_not_called()
    assert ar._last_passage_source == "baked"
    assert len(ar._PASSAGE_CACHE["vectors"]) == count
    assert results


def test_negative_control_the_real_catalog_with_one_edit_embeds_live(client, monkeypatch, tmp_path):
    monkeypatch.setattr(bake_script, "EmbeddingClient", lambda: client)
    output = tmp_path / "baked.npz"
    monkeypatch.setattr(acv, "BAKED_VECTORS_PATH", output)
    bake_script.bake(output)
    client.embed_passages.reset_mock()

    actions = [dict(e) for e in list_action_gateway_actions()]
    first_wired = next(i for i, e in enumerate(actions) if acv.is_wired(e))
    actions[first_wired]["label"] = "an edit the image never baked"
    ar.search_actions("open settings", {"actions": actions}, limit=3)

    client.embed_passages.assert_called_once()
    assert ar._last_passage_source == "live"


def test_the_bake_imports_without_any_runtime_secret():
    """The image build has no secrets; the bake must never reach hushh_mcp.config."""
    env = {"PATH": os.environ.get("PATH", ""), "HOME": os.environ.get("HOME", "")}
    probe = (
        "import sys, scripts.ops.bake_action_catalog_vectors; "
        "assert 'hushh_mcp.config' not in sys.modules, 'config imported'; "
        "assert 'hushh_mcp.one_adk' not in sys.modules, 'one_adk imported'"
    )
    completed = subprocess.run(  # noqa: S603 - fixed interpreter and repository-owned source
        [sys.executable, "-c", probe],
        cwd=BACKEND_ROOT,
        env=env,
        capture_output=True,
        text=True,
        timeout=120,
    )
    assert completed.returncode == 0, completed.stderr[-2000:]


def test_the_backend_image_bakes_after_the_model_and_source_and_before_dropping_root():
    lines = [line.strip() for line in (BACKEND_ROOT / "Dockerfile").read_text().splitlines()]

    def index_of(fragment: str) -> int:
        matches = [i for i, line in enumerate(lines) if fragment in line]
        assert len(matches) == 1, f"expected exactly one line containing {fragment!r}"
        return matches[0]

    model = index_of("COPY --from=builder /opt/hushh/models /opt/hushh/models")
    source = index_of("COPY . .")
    bake = index_of("python -m scripts.ops.bake_action_catalog_vectors")
    user = index_of("USER 10001")
    assert model < source < bake < user
    # The runtime reads the file from the directory the image copies the model into.
    assert Path(BAKED_MODEL_DIR).parent == Path("/opt/hushh/models")
