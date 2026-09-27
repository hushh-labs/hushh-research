"""Bounded-memory reverse fold of full owner-encrypted session revisions."""

import json
from typing import Any


class SessionFold:
    def __init__(self, *, owner: str, hushh_id: str, baseline: dict):
        self.owner, self.hushh_id = owner, hushh_id
        self.baseline = baseline
        self.latest: dict = {}
        self.expected: dict = {}

    def visit(self, record: dict) -> None:
        from hushh_mcp.one_adk.pod_adk_session_repository import (
            _KIND,
            PodAdkSessionRepository,
            PodAdkSessionUnavailable,
        )

        if record.get("kind") != _KIND:
            return
        p = record.get("payload")
        if (
            not isinstance(p, dict)
            or type(p.get("format")) is not int
            or p["format"] != 1
            or p.get("owner") != self.owner
            or p.get("hushhId") != self.hushh_id
            or type(p.get("previous")) is not int
            or p["previous"] < 0
        ):
            raise PodAdkSessionUnavailable("Pod conversation record invalid.")
        PodAdkSessionRepository._validate_identity(p.get("app"), p.get("session"))
        key = p["app"], p["session"]
        row: Any
        if p.get("operation") == "delete":
            if key in self.expected:
                raise PodAdkSessionUnavailable("Pod conversation is deleted.")
            row = {"revision": p["previous"] + 1, "deleted": True, "session_id": p["session"]}
        elif p.get("operation") == "write":
            row = p.get("record")
            if (
                not isinstance(row, dict)
                or type(row.get("revision")) is not int
                or row["revision"] != p["previous"] + 1
                or row.get("session_id") != p["session"]
            ):
                raise PodAdkSessionUnavailable("Pod conversation record invalid.")
            PodAdkSessionRepository._validate_payload(
                {k: row.get("payload_" + k) for k in ("ciphertext", "iv", "tag", "algorithm")}
            )
            row = {**row, "_sequence": record["seq"]}
        else:
            raise PodAdkSessionUnavailable("Pod conversation operation invalid.")
        if key in self.expected:
            if p["previous"] + 1 != self.expected[key]:
                raise PodAdkSessionUnavailable("Pod conversation revision invalid.")
        else:
            self.latest[key] = row
            self._check_capacity()
        self.expected[key] = p["previous"]

    def _check_capacity(self):
        from hushh_mcp.one_adk.pod_adk_session_repository import (
            _MAX_PROJECTION_BYTES,
            _MAX_SESSIONS,
            PodAdkSessionUnavailable,
        )

        entries = {**self.baseline, **self.latest}
        if (
            len(entries) > _MAX_SESSIONS
            or len(json.dumps(list(entries.values())).encode()) > _MAX_PROJECTION_BYTES
        ):
            raise PodAdkSessionUnavailable("Pod conversation capacity reached.")

    def finish(self) -> dict:
        from hushh_mcp.one_adk.pod_adk_session_repository import PodAdkSessionUnavailable

        for key, expected in self.expected.items():
            previous = self.baseline.get(key)
            if (previous and previous.get("deleted")) or expected != (
                previous["revision"] if previous else 0
            ):
                raise PodAdkSessionUnavailable("Pod conversation checkpoint ancestry invalid.")
        return {**self.baseline, **self.latest}
