"""/api/eval: what the offline eval batches on the owner's Drive concluded.

Read from the private eval workdir only (``batches/<id>/``): the founder report
lines, the three gates, the Ready-packet metric the founder report uses
(``ready_correct_one_per_family``: wrong of judged, undecided, checked by a
person) and what a person still has to decide. Nothing here is recomputed with
different rules; the dashboard shows the eval's own numbers.
"""

from __future__ import annotations

import json
import threading
from pathlib import Path

from hushh_eval.drive_packets.contracts import JudgmentRow, PacketRow, QueueRow, read_rows

GATES = ("listing", "ready", "deploy")
READY_METRIC = "ready_correct_one_per_family"
FINAL_JUDGES = {"consensus", "deterministic"}


def _json(path: Path):
    try:
        return json.loads(path.read_text())
    except (OSError, ValueError):
        return None


def batch_dirs(workdir: Path | None) -> list[Path]:
    root = Path(workdir) / "batches" if workdir else None
    if root is None or not root.is_dir():
        return []
    return sorted(path for path in root.iterdir() if path.is_dir() and not path.is_symlink())


def final_verdicts(judgments: list[JudgmentRow]) -> dict[str, dict]:
    """Per packet key: the eval's final AI verdict (a deterministic failure is final,
    otherwise the J1/J2 consensus) and whether a person decided it (judge 'human')."""
    seen: dict[str, dict] = {}
    for row in judgments:
        entry = seen.setdefault(row.packet_key, {})
        if row.judge_id in FINAL_JUDGES | {"human"}:
            entry[row.judge_id] = (row.verdict, row.severity)
    result = {}
    for key, entry in seen.items():
        deterministic, consensus = entry.get("deterministic"), entry.get("consensus")
        final = (
            deterministic
            if deterministic and deterministic[0] == "fail"
            else consensus or deterministic
        )
        result[key] = {
            "ai": final[0] if final else None,
            "severity": final[1] if final else None,
            "human": entry["human"][0] if entry.get("human") else None,
        }
    return result


def batch_packets(path: Path) -> list[dict]:
    """Ready packets of one batch (anchors excluded) with their final verdicts."""
    try:
        packets = read_rows(path / "packets.jsonl", PacketRow)
        judgments = read_rows(path / "judgments.jsonl", JudgmentRow)
    except (OSError, ValueError):
        return []
    verdicts = final_verdicts(judgments)
    rows = []
    for packet in packets:
        if packet.state != "ready" or packet.packet_key.startswith("anchor"):
            continue
        verdict = verdicts.get(packet.packet_key, {})
        rows.append(
            {
                "batch": path.name,
                "packet_key": packet.packet_key,
                "ai": verdict.get("ai") or "unknown",
                "severity": verdict.get("severity"),
                "human": verdict.get("human"),
            }
        )
    return rows


def batch_view(path: Path) -> dict:
    scores = _json(path / "scores.json") or {}
    plan = _json(path / "plan.json") or {}
    metric = next(
        (row for row in scores.get("scores") or [] if row.get("metric") == READY_METRIC), {}
    )
    trials = int(metric.get("trials") or 0)
    gates = {}
    for name in GATES:
        gate = _json(path / f"gate-{name}.json")
        gates[name] = (
            {
                "status": gate.get("status"),
                "exit_code": gate.get("exit_code"),
                "reasons": gate.get("reasons") or [],
            }
            if isinstance(gate, dict)
            else {"status": "not_run", "exit_code": None, "reasons": []}
        )
    try:
        lines = [line for line in (path / "report.md").read_text().splitlines() if line.strip()]
    except OSError:
        lines = []
    return {
        "batch_id": path.name,
        "code_sha": scores.get("code_sha") or (plan.get("runtime") or {}).get("code_sha"),
        "mode": scores.get("mode"),
        "founder_report_lines": lines,
        "gates": gates,
        "ready_wrong": trials - int(metric.get("successes") or 0) if metric else None,
        "ready_total": trials if metric else None,
        "undecided": int(metric.get("n_unknown") or 0) if metric else None,
        "human_checked": int(scores.get("human_confirmed_ready") or 0),
        "scored": bool(scores),
        "label_version": scores.get("label_version"),
        "judges": {
            key: (plan.get("judge") or {}).get(key)
            for key in ("j1", "j2", "rubric", "runtime_model")
        },
        "files": scores.get("files"),
        "packets_by_state": (scores.get("packets") or {}).get("states"),
    }


def human_queue(paths: list[Path]) -> dict:
    """Ready packets still waiting for a person, across every batch."""
    wrong = undecided = high_risk = 0
    for path in paths:
        packets = batch_packets(path)
        pending = {row["packet_key"]: row for row in packets if row["human"] is None}
        wrong += sum(row["ai"] == "fail" for row in pending.values())
        undecided += sum(row["ai"] not in {"pass", "fail"} for row in pending.values())
        try:
            queue = read_rows(path / "queue.jsonl", QueueRow)
        except (OSError, ValueError):
            queue = []
        high_risk += len(
            {
                row.subject
                for row in queue
                if row.reason == "high_risk_ready"
                and row.subject.removeprefix("packet:") in pending
            }
        )
    return {"wrong": wrong, "undecided": undecided, "high_risk": high_risk}


class EvalView:
    """Cached by the batch files' modification times."""

    def __init__(self, workdir: Path | None):
        self.workdir = Path(workdir) if workdir else None
        self._lock = threading.Lock()
        self._stamp = None
        self._value = None
        self._ready_stamp = None
        self._ready: list[dict] | None = None

    def _signature(self, paths: list[Path]):
        stamp = []
        for path in paths:
            for name in (
                "scores.json",
                "judgments.jsonl",
                "packets.jsonl",
                "queue.jsonl",
                "report.md",
            ):
                try:
                    stamp.append((path.name, name, (path / name).stat().st_mtime_ns))
                except OSError:
                    stamp.append((path.name, name, None))
        return tuple(stamp)

    def paths(self) -> list[Path]:
        return batch_dirs(self.workdir)

    def view(self) -> dict:
        paths = self.paths()
        signature = self._signature(paths)
        with self._lock:
            if self._value is not None and self._stamp == signature:
                return self._value
        value = {
            "workdir_found": bool(self.workdir and self.workdir.is_dir()),
            "batches": [batch_view(path) for path in paths],
            "human_queue": human_queue(paths),
        }
        with self._lock:
            self._stamp, self._value = signature, value
        return value

    def ready_packets(self) -> list[dict]:
        paths = self.paths()
        signature = self._signature(paths)
        with self._lock:
            if self._ready is not None and self._ready_stamp == signature:
                return list(self._ready)
        rows = [row for path in paths for row in batch_packets(path)]
        with self._lock:
            self._ready_stamp, self._ready = signature, rows
        return list(rows)
