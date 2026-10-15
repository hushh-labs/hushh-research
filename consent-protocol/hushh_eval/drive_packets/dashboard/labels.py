"""Human labels and the offline eval's judge verdicts, kept private and local.

Labels are append-only JSONL in the private dashboard directory: a 0700
directory outside every git worktree, 0600 files, never published. The newest
line for a packet, an ask result or a real request document is its current label.

A packet label is also kept in the eval package's human-verdict format
(``JudgmentRow`` with judge ``human``) in ``judgments.served.jsonl``, one row per
labeled packet version (Not sure writes no row, as in ``label --interactive``).
Dashboard packets are what UAT serves, not a batch's replay packets, so these
rows do not change a batch's "checked by a person" count.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import threading
from collections import defaultdict
from datetime import UTC, datetime
from pathlib import Path

from hushh_eval.drive_packets.contracts import (
    CaseRow,
    JudgmentRow,
    PacketRow,
    read_rows,
    replace_rows,
)
from hushh_eval.drive_packets.privacy import PrivateWorkdir

PACKET_VERDICTS = ("correct", "wrong", "unsure")
WRONG_REASONS = ("wrong_period", "wrong_person", "duplicate", "overclaims_complete", "other")
ASK_VERDICTS = ("right", "wrong", "unsure", "missed")
REQUEST_VERDICTS = ASK_VERDICTS
NOTE_MAX = 2000
DOCUMENT_ID_MAX = 512
SERVED_BATCH = "served-uat"
# The eval's severity scale (labels.SEVERITY_PROMPT): S1 wrong person, account or
# period; S2 incomplete, duplicate, missing or unrelated member.
SEVERITY = {
    "wrong_period": "S1",
    "wrong_person": "S1",
    "duplicate": "S2",
    "overclaims_complete": "S2",
    "other": "S2",
}
SAFE_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$")


class LabelError(ValueError):
    """A label was refused; the message is a fixed code."""


def _now() -> str:
    return datetime.now(UTC).isoformat(timespec="seconds")


def _note(value) -> str:
    note = "" if value is None else str(value).strip()
    if len(note) > NOTE_MAX:
        raise LabelError("note_too_long")
    return note


def _document_id(value) -> str | None:
    if value is None:
        return None
    text = str(value).strip()
    if not text or len(text) > DOCUMENT_ID_MAX or any(ord(char) < 32 for char in text):
        raise LabelError("document_id_invalid")
    return text


def normalize_reason(value) -> str | None:
    """Accept "wrong period", "wrong-period" or "wrong_period"."""
    if value is None:
        return None
    text = re.sub(r"[\s-]+", "_", str(value).strip().casefold())
    if not text:
        return None
    if text not in WRONG_REASONS:
        raise LabelError("reason_invalid")
    return text


def served_packet_key(packet_id: str, version) -> str:
    """Key in the replay scheme (sha256 of mode and identity), for UAT-served packets."""
    return hashlib.sha256(f"served\0{packet_id}:{version}".encode()).hexdigest()[:32]


class LabelStore:
    """Append-only label files in the private dashboard directory."""

    def __init__(self, directory: Path):
        self.workdir = PrivateWorkdir(Path(directory))
        self.path = self.workdir.path
        self.packet_file = self.path / "packet_labels.jsonl"
        self.ask_label_file = self.path / "ask_labels.jsonl"
        self.ask_file = self.path / "asks.jsonl"
        self.request_label_file = self.path / "request_labels.jsonl"
        self.served_file = self.path / "judgments.served.jsonl"
        self._lock = threading.Lock()

    # Files --------------------------------------------------------------------------
    def _append(self, path: Path, record: dict) -> None:
        line = (json.dumps(record, sort_keys=True, ensure_ascii=False) + "\n").encode()
        with self._lock:
            descriptor = os.open(
                path, os.O_CREAT | os.O_WRONLY | os.O_APPEND | os.O_NOFOLLOW, 0o600
            )
            try:
                os.fchmod(descriptor, 0o600)
                os.write(descriptor, line)
                os.fsync(descriptor)
            finally:
                os.close(descriptor)

    @staticmethod
    def _read(path: Path) -> list[dict]:
        if not path.exists():
            return []
        records = []
        for line in path.read_text().splitlines():
            if not line.strip():
                continue
            try:
                value = json.loads(line)
            except ValueError:
                continue
            if isinstance(value, dict):
                records.append(value)
        return records

    # Packets ------------------------------------------------------------------------
    def save_packet_label(
        self, *, packet_id: str, version, verdict: str, reason=None, note=None
    ) -> dict:
        if verdict not in PACKET_VERDICTS:
            raise LabelError("verdict_invalid")
        reason = normalize_reason(reason) if verdict == "wrong" else None
        record = {
            "schema": "dashboard.packet_label.v1",
            "at": _now(),
            "packet_id": str(packet_id),
            "version": version,
            "verdict": verdict,
            "reason": (reason or "other") if verdict == "wrong" else None,
            "note": _note(note),
            "labeler": "founder",
        }
        self._append(self.packet_file, record)
        self._write_served_judgments()
        return record

    def packet_labels(self) -> dict[str, dict]:
        """Newest label per packet id."""
        latest: dict[str, dict] = {}
        for record in self._read(self.packet_file):
            if record.get("packet_id"):
                latest[record["packet_id"]] = record
        return latest

    def _write_served_judgments(self) -> None:
        latest: dict[tuple, dict] = {}
        for record in self._read(self.packet_file):
            latest[(record.get("packet_id"), record.get("version"))] = record
        rows = []
        for (packet_id, version), record in sorted(latest.items(), key=lambda item: str(item[0])):
            if record.get("verdict") not in {"correct", "wrong"}:
                continue
            wrong = record["verdict"] == "wrong"
            reason = record.get("reason") or "other"
            rows.append(
                JudgmentRow(
                    batch_id=SERVED_BATCH,
                    packet_key=served_packet_key(packet_id, version),
                    judge_id="human",
                    model_version="human:dashboard",
                    prompt_sha256=None,
                    seed=None,
                    variant="primary",
                    verdict="fail" if wrong else "pass",
                    failed_checks=["human_review", reason] if wrong else [],
                    severity=SEVERITY.get(reason, "S2") if wrong else None,
                    citations_valid=None,
                )
            )
        with self._lock:
            replace_rows(self.served_file, rows)
            os.chmod(self.served_file, 0o600)

    # Asks ---------------------------------------------------------------------------
    def save_ask(self, record: dict) -> None:
        ask_id = record.get("ask_id")
        if not isinstance(ask_id, str) or not SAFE_ID.fullmatch(ask_id):
            raise LabelError("ask_id_invalid")
        self._append(self.ask_file, {"schema": "dashboard.ask.v1", "at": _now(), **record})

    def _ask_file(self, ask_id: str) -> Path | None:
        """The request engine's own record (asks/<ask_id>.json), when it saved one."""
        if not isinstance(ask_id, str) or not SAFE_ID.fullmatch(ask_id):
            return None
        path = self.path / "asks" / f"{ask_id}.json"
        return path if path.is_file() and not path.is_symlink() else None

    @staticmethod
    def _engine_record(path: Path) -> dict | None:
        try:
            value = json.loads(path.read_text())
        except (OSError, ValueError):
            return None
        result = value.get("result") if isinstance(value, dict) else None
        return result if isinstance(result, dict) and result.get("ask_id") else None

    def known_ask(self, ask_id: str) -> dict | None:
        found = None
        for record in self._read(self.ask_file):
            if record.get("ask_id") == ask_id:
                found = record
        if found is None:
            path = self._ask_file(ask_id)
            found = self._engine_record(path) if path else None
        return found

    def asks(self) -> list[dict]:
        """Every dry run on record, newest record per ask id: the request engine's own
        files (asks/<ask_id>.json) and the ones this server kept (asks.jsonl)."""
        latest: dict[str, dict] = {}
        folder = self.path / "asks"
        if folder.is_dir():
            for path in sorted(folder.glob("*.json")):
                record = None if path.is_symlink() else self._engine_record(path)
                if record and SAFE_ID.fullmatch(str(record["ask_id"])):
                    latest[record["ask_id"]] = record
        for record in self._read(self.ask_file):
            if isinstance(record.get("ask_id"), str):
                latest[record["ask_id"]] = record
        return list(latest.values())

    def save_ask_label(self, *, ask_id: str, document_id, verdict: str, note=None) -> dict:
        if verdict not in ASK_VERDICTS:
            raise LabelError("verdict_invalid")
        if not isinstance(ask_id, str) or not SAFE_ID.fullmatch(ask_id):
            raise LabelError("ask_id_invalid")
        record = {
            "schema": "dashboard.ask_label.v1",
            "at": _now(),
            "ask_id": ask_id,
            "document_id": _document_id(document_id),
            "verdict": verdict,
            "note": _note(note),
            "labeler": "founder",
        }
        self._append(self.ask_label_file, record)
        return record

    def ask_labels(self, ask_id: str | None = None) -> dict:
        """Newest label per document of one ask (key None is the overall label), or of
        every ask as {ask_id: {document_id: label}} when no ask id is given."""
        latest: dict = {}
        for record in self._read(self.ask_label_file):
            if ask_id is None:
                latest.setdefault(record.get("ask_id"), {})[record.get("document_id")] = record
            elif record.get("ask_id") == ask_id:
                latest[record.get("document_id")] = record
        return latest

    # Real requests -------------------------------------------------------------------
    def save_request_label(self, *, request_id: str, document_id, verdict: str, note=None) -> dict:
        """A label on a request the deployed backend handled (request id already checked
        to be one of the owner's)."""
        if verdict not in REQUEST_VERDICTS:
            raise LabelError("verdict_invalid")
        record = {
            "schema": "dashboard.request_label.v1",
            "at": _now(),
            "request_id": str(request_id),
            "document_id": _document_id(document_id),
            "verdict": verdict,
            "note": _note(note),
            "labeler": "founder",
        }
        self._append(self.request_label_file, record)
        return record

    def request_labels(self, request_id: str | None = None) -> dict:
        """Newest label per document of one request, or {request_id: {...}} for all."""
        latest: dict = {}
        for record in self._read(self.request_label_file):
            if request_id is None:
                latest.setdefault(record.get("request_id"), {})[record.get("document_id")] = record
            elif record.get("request_id") == request_id:
                latest[record.get("document_id")] = record
        return latest


class EvalVerdicts:
    """Judge verdicts the offline eval gave a batch packet with exactly the same documents.

    Batch packets are replays formed among sampled files, so most served packets
    have no match; a match means the same member documents, not the same claims.
    """

    def __init__(self, workdir: Path | None):
        self.workdir = Path(workdir) if workdir else None
        self._index: dict[frozenset, list[dict]] | None = None
        self._lock = threading.Lock()

    def _load(self) -> dict[frozenset, list[dict]]:
        index: dict[frozenset, list[dict]] = defaultdict(list)
        batches = self.workdir / "batches" if self.workdir else None
        if batches is None or not batches.is_dir():
            return {}
        for batch in sorted(path for path in batches.iterdir() if path.is_dir()):
            try:
                cases = {
                    row.case_id: row.document_uuid
                    for row in read_rows(batch / "cases.jsonl", CaseRow)
                }
                packets = read_rows(batch / "packets.jsonl", PacketRow)
                judgments = read_rows(batch / "judgments.jsonl", JudgmentRow)
            except (OSError, ValueError):
                continue
            by_packet = defaultdict(list)
            for row in judgments:
                by_packet[row.packet_key].append(row)
            for packet in packets:
                documents = [cases.get(case_id) for case_id in packet.selected_case_ids]
                if not documents or None in documents:
                    continue
                for row in by_packet.get(packet.packet_key, []):
                    index[frozenset(documents)].append(
                        {
                            "judge": row.judge_id
                            if row.variant in {"primary", "consensus"}
                            else f"{row.judge_id}:{row.variant}",
                            "verdict": row.verdict,
                            "severity": row.severity,
                            "batch": row.batch_id,
                            "eval_state": packet.state,
                        }
                    )
        return dict(index)

    def for_documents(self, document_ids) -> list[dict]:
        with self._lock:
            if self._index is None:
                self._index = self._load()
        return [dict(item) for item in self._index.get(frozenset(map(str, document_ids)), [])]
