"""The manifest loader must READ what exists, not assert a hand-kept list.

`_load_product_agent_manifest` keyed on the DIRECTORY name and hard-coded an
allowlist of `{"one", "kai"}`. Two separate problems lived in that one line:

1. Directory names and manifest ids have never matched. Every directory is
   `email` / `kyc` / `one`; every declared id is `agent_email` / `agent_kyc` /
   `agent_one`. So the loader's key space and the manifests' own key space were
   disjoint, and only the allowlist hid it -- the two names it accepted were
   the two it never had to reconcile.
2. The allowlist made "which agents exist" a literal maintained by hand. That is
   the same shape as the `["one","kai","nav","kyc"]` roster literal in `/health`,
   which reported four agents from a pod running none and was then quoted back
   as proof the pod worked.

These tests are written against the manifests on disk rather than against a
list repeated here, because a test that repeats the literal it is guarding
fails only when someone edits both -- which is precisely how the original
survived review.
"""

from __future__ import annotations

from pathlib import Path

import pytest
import yaml

from hushh_mcp.one_adk.agent_tree import (
    _AGENTS_ROOT,
    _load_product_agent_manifest,
    _product_agent_manifest_index,
)


def _authored_dirs() -> list[Path]:
    return sorted(p for p in _AGENTS_ROOT.glob("*/agent.yaml"))


def test_every_authored_manifest_is_reachable_by_its_declared_id():
    """The allowlist made 16 of 18 manifests invisible to this module."""
    index, unreadable = _product_agent_manifest_index()

    assert not unreadable, f"manifests that could not be indexed: {unreadable}"
    assert len(index) == len(_authored_dirs()), (
        "every agent.yaml on disk must be indexed; "
        f"found {len(_authored_dirs())} files but indexed {len(index)}"
    )
    for agent_id in index:
        assert _load_product_agent_manifest(agent_id).id == agent_id


def test_the_index_key_is_the_manifest_id_not_the_directory_name():
    """The exact confusion the allowlist concealed.

    If these two ever became equal the loader could key on either and this test
    would stop being meaningful -- so it asserts they genuinely differ, and
    names the pair, rather than asserting a prefix convention that a future
    manifest is free to break.
    """
    index, _ = _product_agent_manifest_index()
    differing = [
        (path.parent.name, agent_id)
        for agent_id, path in index.items()
        if path.parent.name != agent_id
    ]
    assert differing, (
        "no manifest id differs from its directory name -- if that is now true "
        "by design, this test and the loader's id-keying should be revisited "
        "together rather than one of them quietly relaxed"
    )
    for directory, agent_id in differing:
        assert agent_id == yaml.safe_load(
            (_AGENTS_ROOT / directory / "agent.yaml").read_text(encoding="utf-8")
        )["id"]


def test_the_two_product_manifests_one_actually_loads_are_present():
    """Roster unchanged. This step re-keyed the lookup and nothing else.

    Pinned so that a later change which does intend to alter One's roster has to
    say so here, instead of the roster drifting as a side effect of an unrelated
    loader edit.
    """
    index, _ = _product_agent_manifest_index()
    assert "agent_one" in index
    assert "agent_kai" in index
    assert _load_product_agent_manifest("agent_one").id == "agent_one"
    assert _load_product_agent_manifest("agent_kai").id == "agent_kai"


def test_an_unknown_id_names_what_is_known():
    """A lookup failure has to be diagnosable without reading this file.

    The old error said only "Unsupported product-agent manifest: kyc", which is
    indistinguishable between "no such agent" and "that agent exists but I was
    built not to see it" -- and it was always the second one.
    """
    with pytest.raises(ValueError) as excinfo:
        _load_product_agent_manifest("agent_does_not_exist")

    message = str(excinfo.value)
    assert "agent_does_not_exist" in message
    assert "agent_one" in message, "the error must list what IS known"


def test_the_old_directory_name_lookup_is_rejected():
    """`"one"` used to be the correct argument; it must now fail loudly.

    Silently accepting both spellings would leave two key spaces alive at once,
    which is the condition that produced the bug in the first place.
    """
    with pytest.raises(ValueError):
        _load_product_agent_manifest("one")
