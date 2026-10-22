"""Encrypted evidence in the local export checkpoint, not a second product index.

The canonical Drive cipher owns key loading and AEAD. This derived snapshot adds
source-version, model and export-context binding. Plaintext is projected only
for an explicitly requested private export; it never enters checkpoint items.
"""

from __future__ import annotations

import hashlib
import json
import math

from hushh_mcp.services.drive_group_index_store import DriveGroupCipher
from hushh_mcp.services.drive_groups.contract import EMBEDDING_DIMENSIONS
from hushh_mcp.services.drive_groups.export import COLUMNS
from hushh_mcp.services.drive_groups.text_head import HEAD_CHARS
from hushh_mcp.services.embedding_client_leaf import MODEL_ID, MODEL_REVISION

BASE_CONTENT_COLUMNS = (
    *COLUMNS,
    "file_id",
    "source_version",
    "evidence_mode",
    "content_ref",
    "content_status",
    "text_start_chars",
    "text_start",
    "embedding_dimensions",
    "embedding_model",
    "embedding_revision",
    "embedding",
)
CONTENT_COLUMNS = (
    *BASE_CONTENT_COLUMNS,
    "extractor_policy",
    "extraction_method",
    "extraction_reason",
)


def checkpoint_columns(saved):
    columns = tuple(saved.get("csv_columns", BASE_CONTENT_COLUMNS))
    if columns not in {BASE_CONTENT_COLUMNS, CONTENT_COLUMNS}:
        raise RuntimeError("content_invalid")
    return columns


def retry_prefix_failures(saved, cached):
    """Keep authenticated successes; retry old failures under a new parser policy."""
    from hushh_mcp.services.drive_document_prefix import DOCX, PREFIX_POLICY

    policy = saved.get("extractor_policy", "drive-prefix-v1")
    if policy not in {"drive-prefix-v1", PREFIX_POLICY}:
        raise RuntimeError("content_invalid")
    if policy == PREFIX_POLICY:
        return cached
    return {
        identity: item
        for identity, item in cached.items()
        if not (
            item["item"].get("index_status") == "prefix_unreadable"
            and item["item"].get("mime_type")
            in {"application/pdf", DOCX, "text/plain", "text/markdown"}
        )
    }


def content_context():
    return {
        "content_schema": 1,
        "head_chars": HEAD_CHARS,
        "embedding_model": MODEL_ID,
        "embedding_revision": MODEL_REVISION,
    }


class LocalExportContent:
    def __init__(self, *, owner: str, context: dict, cipher=None):
        self.owner, self.context = owner, context
        self.cipher = cipher or DriveGroupCipher()
        if (
            not isinstance(owner, str)
            or not owner
            or context.get("owner") != hashlib.sha256(owner.encode()).hexdigest()
            or any(context.get(key) != value for key, value in content_context().items())
            or type(context.get("generation")) is not int
        ):
            raise RuntimeError("content_context_changed")
        self.context_hash = hashlib.sha256(
            json.dumps(context, sort_keys=True, separators=(",", ":"), allow_nan=False).encode()
        ).hexdigest()
        # Fail before provider I/O if the canonical processing key is missing.
        self.cipher.ref(owner, "local-export-key-check")

    def reference(self, file_id: str) -> str:
        return self.cipher.ref(self.owner, json.dumps(["local-drive-export-v1", file_id]))

    @property
    def header(self):
        return {"schema": 1, "owner": self.owner, "context_hash": self.context_hash}

    @staticmethod
    def _validate(head, vector):
        if head is not None and (not isinstance(head, str) or not 1 <= len(head) <= HEAD_CHARS):
            raise RuntimeError("content_invalid")
        if vector is not None and (
            head is None
            or not isinstance(vector, list)
            or len(vector) != EMBEDDING_DIMENSIONS
            or any(type(value) not in {float, int} or not math.isfinite(value) for value in vector)
            or not math.isclose(sum(value * value for value in vector), 1.0, abs_tol=0.002)
        ):
            raise RuntimeError("content_invalid")

    def seal(self, row, file, item, *, extraction=None):
        head, vector = file.head, list(file.vector) if file.vector is not None else None
        self._validate(head, vector)
        metadata = {
            **{key: item.get(key, "") for key in COLUMNS},
            "file_id": file.file_id,
            "source_version": row["version"],
            "evidence_mode": self.context.get("evidence_mode", "full"),
            "content_ref": self.reference(file.file_id),
            "content_status": "text_and_embedding"
            if vector is not None
            else "text_only"
            if head
            else "no_text",
            "text_start_chars": len(head) if head else 0,
            "embedding_dimensions": len(vector) if vector else 0,
            "embedding_model": MODEL_ID if vector else "",
            "embedding_revision": MODEL_REVISION if vector else "",
            **(extraction or {}),
        }
        payload = {
            "schema": 1,
            "context_hash": self.context_hash,
            "source_version": row["version"],
            "file_id": file.file_id,
            "item": metadata,
            "shelf": file.placement.shelf,
            "head": head,
            "vector": vector,
        }
        envelope = self.cipher.seal_entry(
            payload,
            user_id=self.owner,
            ref=metadata["content_ref"],
            generation=self.context["generation"],
        )
        return {
            "version": row["version"],
            "shelf": file.placement.shelf,
            "item": metadata,
            "content": envelope,
        }

    def open(self, file_id: str, cached: dict):
        try:
            reference = self.reference(file_id)
            payload = self.cipher.open_entry(
                {
                    "user_id": self.owner,
                    "source_ref": reference,
                    "connection_generation": self.context["generation"],
                    "entry_envelope": cached["content"],
                }
            )
            if (
                payload.get("schema") != 1
                or payload.get("context_hash") != self.context_hash
                or payload.get("file_id") != file_id
                or payload.get("source_version") != cached["version"]
                or payload.get("item") != cached["item"]
                or payload.get("shelf") != cached["shelf"]
                or cached["item"]["content_ref"] != reference
            ):
                raise ValueError("binding")
            self._validate(payload["head"], payload["vector"])
            return payload
        except Exception:
            raise RuntimeError("content_invalid") from None

    def project(self, file_id: str, cached: dict, *, include_content: bool):
        payload = self.open(file_id, cached)
        item = dict(cached["item"])
        if "extractor_policy" not in item and item.get("evidence_mode") == "raw_prefix_204800":
            item.update(
                extractor_policy="drive-prefix-v1", extraction_method="legacy", extraction_reason=""
            )
        if (
            item.get("index_status") == "prefix_unreadable"
            and item.get("extraction_method") not in {None, "", "legacy"}
            and not item.get("extraction_reason")
        ):
            item["extraction_reason"] = "no_usable_head"
        if include_content:
            item["text_start"] = payload["head"] or ""
            item["embedding"] = (
                json.dumps(payload["vector"], separators=(",", ":"), allow_nan=False)
                if payload["vector"] is not None
                else ""
            )
        return item

    def manifest(self, saved):
        payload = {
            "purpose": "local-drive-export-manifest-v1",
            "schema": 1,
            "context_hash": self.context_hash,
            "snapshot_digest": _digest(saved),
        }
        return self.cipher.seal_entry(
            payload,
            user_id=self.owner,
            ref=self.cipher.ref(self.owner, "local-drive-export-manifest-v1"),
            generation=self.context["generation"],
        )

    def verify_manifest(self, saved):
        payload = self.cipher.open_entry(
            {
                "user_id": self.owner,
                "source_ref": self.cipher.ref(self.owner, "local-drive-export-manifest-v1"),
                "connection_generation": self.context["generation"],
                "entry_envelope": saved["content_manifest"],
            }
        )
        if payload != {
            "purpose": "local-drive-export-manifest-v1",
            "schema": 1,
            "context_hash": self.context_hash,
            "snapshot_digest": _digest(
                {key: value for key, value in saved.items() if key != "content_manifest"}
            ),
        }:
            raise RuntimeError("content_invalid")


def _digest(value):
    return hashlib.sha256(
        json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False).encode()
    ).hexdigest()


def open_checkpoint(saved: dict):
    """Authenticate a committed derived snapshot without provider or model I/O."""
    try:
        content = LocalExportContent(
            owner=saved["content_index"]["owner"], context=saved["context"]
        )
        if saved["content_index"] != content.header:
            raise ValueError("header")
        content.verify_manifest(saved)
        checkpoint_columns(saved)
        inventory = {row["id"]: row for row in saved["inventory"]["rows"]}
        for file_id, cached in saved["items"].items():
            if cached["version"] != inventory[file_id]["version"]:
                raise ValueError("source_version")
            content.open(file_id, cached)
        return content
    except Exception:
        raise RuntimeError("content_invalid") from None
