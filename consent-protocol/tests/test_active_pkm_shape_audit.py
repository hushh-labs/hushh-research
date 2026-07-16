from importlib.util import module_from_spec, spec_from_file_location
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts/audit_active_pkm_shape_readonly.py"
SPEC = spec_from_file_location("audit_active_pkm_shape_readonly", SCRIPT)
assert SPEC and SPEC.loader
MODULE = module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


def test_shape_audit_redacts_values_and_bounds_paths():
    payload = {
        "records": {
            "actual-person@example.com": {
                "private_value": "must-not-appear",
                "heterogeneous": [{"a": 1}, {"b": False}],
            }
        }
    }
    summary = MODULE.summarize_payload_shape(payload)

    serialized = str(summary)
    assert "must-not-appear" not in serialized
    assert "actual-person@example.com" not in serialized
    assert len(summary["paths"]) <= MODULE._MAX_PATHS
    assert MODULE._occurrence_count(payload) == 3


def test_shape_audit_contract_has_no_event_sample_lane():
    source = SCRIPT.read_text()

    assert "memory_event_sample" not in source
    assert "recent_pkm_events" not in source
    assert "pkm_reviewer_shape_audit.v2" in source
    assert "segment-limit" in source
    assert "while True:" in source
    assert '"has_more": False' in source
    assert '"complete": segment_offset == 0' in source


def test_protected_gate_rejects_partial_shape_audit():
    gate = (ROOT.parent / "scripts/ci/pkm-upgrade-gate.sh").read_text()

    assert 'p["pagination"]["has_more"] is False' in gate
    assert 'p["preservation_receipt"]["complete"] is True' in gate
