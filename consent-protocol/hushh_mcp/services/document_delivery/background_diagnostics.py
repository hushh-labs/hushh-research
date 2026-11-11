"""Bounded observations of the existing copy stages, without source values."""

import time
from contextlib import contextmanager
from uuid import UUID

from hushh_mcp.services.document_delivery.contracts import DeliveryError
from hushh_mcp.services.drive_telemetry import correlation_tag, drive_logger

STAGES = frozenset(
    {
        "authority",
        "credential",
        "source_before",
        "export_before",
        "export_after",
        "copy",
        "source_after",
        "read",
        "verify",
        "publish",
    }
)
FIELDS = frozenset(
    {
        "id",
        "name",
        "mime",
        "identity",
        "size",
        "modified_time",
        "md5",
        "sha256",
        "head_revision",
        "export_revision",
        "body_length",
        "content_encoding",
        "range",
    }
)
IDENTITY_FIELDS = {
    "size": "size",
    "modifiedTime": "modified_time",
    "md5Checksum": "md5",
    "sha256Checksum": "sha256",
    "headRevisionId": "head_revision",
}
logger = drive_logger("drive_copy")


def safe_detail(value):
    if (
        not isinstance(value, dict)
        or not isinstance(value.get("stage"), str)
        or value["stage"] not in STAGES
    ):
        return None
    fields = value.get("mismatches")
    if (
        not isinstance(fields, list)
        or len(fields) > len(FIELDS)
        or any(not isinstance(item, str) or item not in FIELDS for item in fields)
    ):
        return None
    return {"stage": value["stage"], "mismatches": sorted(set(fields))}


class CopySourceChanged(DeliveryError):
    def __init__(self, stage, fields):
        super().__init__("source_changed")
        self.copy_detail = safe_detail({"stage": stage, "mismatches": list(fields)})


@contextmanager
def copy_step(row, stage, *, metadata_time_changed=False):
    started = time.perf_counter()
    outcome, detail = "ok", None
    observation = {"outcome": "ok"}
    try:
        yield observation
    except BaseException as error:
        outcome = "failed"
        detail = error.copy_detail if isinstance(error, CopySourceChanged) else None
        raise
    finally:
        # An unavailable logger, malformed diagnostic row or hashing failure
        # must never change a copy result or replace its original exception.
        try:
            if stage in STAGES:
                if outcome == "ok" and observation.get("outcome") == "deferred":
                    outcome = "deferred"
                request_op = correlation_tag(str(UUID(str(row["request_id"]))))
                file_op = correlation_tag(str(UUID(str(row["file_ref"]))))
                logger.info(
                    "drive_copy.step stage=%s outcome=%s failure_stage=%s mismatch_fields=%s metadata_time_changed=%d duration_ms=%.2f"
                    f" request_op={request_op} file_op={file_op}",
                    stage,
                    outcome,
                    detail["stage"] if detail else "none",
                    ",".join(detail["mismatches"]) if detail else "none",
                    int(metadata_time_changed is True),
                    (time.perf_counter() - started) * 1000,
                )
        except Exception:
            pass
