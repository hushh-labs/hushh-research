"""Pod-side specialist runtime contracts.

Phase 0 of the owner-pod direct runtime: the model-call budget. Lane B extends
this file with the port, access and honest-dependency cases.
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from hushh_mcp.one_adk import text_runtime  # noqa: E402
from hushh_mcp.services import pod_specialist_runtime  # noqa: E402


def test_puppy_specialist_call_budget_covers_the_measured_cold_first_token() -> None:
    """A cold local model measured 32.9s to first token; a 30s cap fails by construction."""
    puppy = pod_specialist_runtime.specialist_model_timeout_seconds("puppy_relay")
    assert puppy >= text_runtime._PUPPY_FIRST_EVENT_TIMEOUT_SECONDS
    assert puppy < text_runtime._TOTAL_TURN_TIMEOUT_SECONDS


def test_other_runtime_modes_keep_the_generic_specialist_budget() -> None:
    generic = pod_specialist_runtime._SPECIALIST_MODEL_TIMEOUT_SECONDS
    assert generic == 30.0
    for mode in ("byok", "user_adc", "hushh_managed_vertex", "", None):
        assert pod_specialist_runtime.specialist_model_timeout_seconds(mode) == generic


def test_the_model_call_reads_its_budget_from_the_helper() -> None:
    """A literal timeout would silently reintroduce the 30s wall for Puppy."""
    source = Path(pod_specialist_runtime.__file__).read_text(encoding="utf-8")
    assert "timeout=specialist_model_timeout_seconds(runtime_mode)" in source
    assert "timeout=30," not in source
