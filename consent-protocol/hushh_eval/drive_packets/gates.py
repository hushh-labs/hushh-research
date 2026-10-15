"""Gate decisions with exit codes: 0 pass, 1 fail, 2 insufficient evidence.

Thresholds live in config/gates.v1.json. Unknown verdicts never pass. A scorecard
computed under a different label version is refused (insufficient).
"""

from __future__ import annotations

import json
from pathlib import Path

from hushh_eval.drive_packets.contracts import GateRow
from hushh_eval.drive_packets.labels import LABEL_VERSION

CONFIG = Path(__file__).with_name("config")
EXIT = {"pass": 0, "fail": 1, "insufficient": 2}


def load_thresholds(path: Path | None = None) -> dict:
    thresholds = json.loads((path or CONFIG / "gates.v1.json").read_text())
    if thresholds.get("schema_version") != "dpe.gates.v1":
        raise ValueError("unsupported_gates_version")
    return thresholds


def _metric(scorecard: dict, name: str) -> dict:
    return next((row for row in scorecard.get("scores", []) if row["metric"] == name), {})


def _row(gate: str, status: str, reasons: list[str], thresholds: dict) -> GateRow:
    return GateRow(
        gate=gate,
        status=status,
        reasons=reasons,
        thresholds_version=thresholds["thresholds_version"],
        exit_code=EXIT[status],
    )


def listing_gate(scorecard: dict, thresholds: dict) -> GateRow:
    rules = thresholds["listing"]
    if scorecard.get("label_version") != LABEL_VERSION:
        return _row("listing", "insufficient", ["stale_label_version"], thresholds)
    gated = _metric(scorecard, "ready_correct_one_per_family")
    trials, successes = gated.get("trials", 0), gated.get("successes", 0)
    open_s1 = (gated.get("extra") or {}).get("open_s1", 0)
    reasons = []
    if rules["require_no_open_s1"] and open_s1:
        reasons.append("open_s1")
    if trials - successes > rules["max_wrong"]:
        reasons.append("ready_packet_wrong")
    if reasons:
        return _row("listing", "fail", reasons, thresholds)
    unknown = gated.get("n_unknown", 0)
    if trials < rules["min_independent_ready"]:
        reasons.append(f"needs_{rules['min_independent_ready']}_independent_ready_has_{trials}")
    if rules["require_human_confirmation"] and scorecard.get("human_confirmed_ready", 0) < trials:
        reasons.append("human_confirmation_missing")
    if trials + unknown and unknown / (trials + unknown) > rules["max_unknown_fraction"]:
        reasons.append("too_many_unknown_verdicts")
    if reasons:
        return _row("listing", "insufficient", reasons, thresholds)
    return _row("listing", "pass", ["cleared"], thresholds)


def ready_gate(scorecard: dict, thresholds: dict) -> GateRow:
    if scorecard.get("label_version") != LABEL_VERSION:
        return _row("ready", "insufficient", ["stale_label_version"], thresholds)
    rate = _metric(scorecard, "false_ready_rate")
    severity = (rate.get("extra") or {}).get("severity", {})
    if severity.get("S1"):
        return _row("ready", "fail", ["open_s1_demote_stratum"], thresholds)
    if not rate.get("trials"):
        return _row("ready", "insufficient", ["no_judged_ready_packets"], thresholds)
    return _row("ready", "pass", ["no_open_s1"], thresholds)


def deploy_gate(
    *,
    guard_status: dict | None,
    anchor: dict | None,
    previous_anchor: dict | None,
    thresholds: dict,
) -> GateRow:
    rules = thresholds["deploy"]
    if guard_status is None:
        return _row("deploy", "insufficient", ["guard_suite_not_run"], thresholds)
    reasons = [f"guard_regression:{case}" for case in guard_status.get("regressions", [])]
    if rules["anchor_new_s1_blocks"] and anchor is not None and previous_anchor is not None:
        before = {key for key, value in previous_anchor.items() if value == "S1"}
        after = {key for key, value in anchor.items() if value == "S1"}
        reasons.extend(f"anchor_new_s1:{key}" for key in sorted(after - before))
    if reasons:
        return _row("deploy", "fail", reasons, thresholds)
    return _row("deploy", "pass", ["guard_suite_clean"], thresholds)
