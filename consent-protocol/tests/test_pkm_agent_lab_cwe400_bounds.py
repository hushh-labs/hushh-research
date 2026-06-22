"""Tests that PKMAgentLabStructureRequest has bounds on unbounded fields (CWE-400).

Without max_length on user_id and max_length on list fields, a caller can send
arbitrarily large payloads that propagate deep into the PKM agent pipeline.

Uses source-level assertions to avoid import-time side effects from middleware
that requires environment variables.
"""

import pathlib
import re

_SRC = pathlib.Path(__file__).parent.parent / "api" / "routes" / "pkm.py"


def _agent_lab_block(src: str) -> str:
    match = re.search(
        r"class PKMAgentLabStructureRequest\(BaseModel\):.*?(?=\nclass |\Z)",
        src,
        re.DOTALL,
    )
    assert match, "PKMAgentLabStructureRequest class not found in pkm.py"
    return match.group(0)


def test_user_id_has_max_length():
    block = _agent_lab_block(_SRC.read_text())
    assert re.search(r"user_id.*max_length\s*=\s*\d+", block), (
        "PKMAgentLabStructureRequest.user_id must declare max_length to prevent CWE-400"
    )


def test_user_id_has_min_length():
    block = _agent_lab_block(_SRC.read_text())
    assert re.search(r"user_id.*min_length\s*=\s*1", block), (
        "PKMAgentLabStructureRequest.user_id must have min_length=1"
    )


def test_current_domains_has_max_length():
    block = _agent_lab_block(_SRC.read_text())
    assert re.search(r"current_domains.*max_length\s*=\s*\d+", block), (
        "PKMAgentLabStructureRequest.current_domains list must declare max_length"
    )


def test_current_manifests_has_max_length():
    block = _agent_lab_block(_SRC.read_text())
    assert re.search(r"current_manifests.*max_length\s*=\s*\d+", block), (
        "PKMAgentLabStructureRequest.current_manifests list must declare max_length"
    )
