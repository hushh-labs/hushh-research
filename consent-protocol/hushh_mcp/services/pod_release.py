"""Validate metadata for the existing operator-selected pod image.

This module is import-safe for the build executor. Configuration provenance is
provided by the governed deployment; this is not a signature verifier or a second
release channel. Compatibility requires an explicitly verified installed digest.
"""

from __future__ import annotations

import base64
import binascii
import json
import os
import re
from datetime import datetime, timezone
from typing import Any, Optional

_DIGEST = re.compile(r"sha256:[0-9a-f]{64}")
_SHA = re.compile(r"[0-9a-f]{40}")
_NOTE_CATEGORIES = {"improvements", "fixes", "security"}
MAX_RELEASE_BYTES = 12000


def _text(value: object, maximum: int) -> str:
    if not isinstance(value, str) or not value.strip() or len(value) > maximum:
        raise ValueError("invalid release text")
    if any(ord(char) < 32 for char in value):
        raise ValueError("invalid release control character")
    return value


_IMAGE_DIGEST_RE = re.compile(r"^sha256:[0-9a-fA-F]{64}$")


def image_digest(reference: object) -> Optional[str]:
    """Extract a valid OCI ``sha256`` digest from a reference or digest field."""
    text = str(reference or "").strip()
    if _IMAGE_DIGEST_RE.fullmatch(text):
        return text
    if "@" not in text:
        return None
    digest = text.rsplit("@", 1)[1].strip()
    return digest if _IMAGE_DIGEST_RE.fullmatch(digest) else None


_IMMUTABLE_IMAGE_RE = re.compile(r"^.+@sha256:[0-9a-fA-F]{64}$")


def is_immutable_image_reference(reference: object) -> bool:
    """Whether an image reference is pinned to a complete OCI digest."""
    return bool(_IMMUTABLE_IMAGE_RE.fullmatch(str(reference or "").strip()))


def validate_descriptor(value: object) -> dict[str, Any]:
    if not isinstance(value, dict) or set(value) != {
        "version",
        "summary",
        "notes",
        "channel",
        "supportedUpgradeDigests",
    }:
        raise ValueError("invalid reviewed release descriptor")
    _text(value["version"], 80)
    _text(value["summary"], 400)
    if value["channel"] not in {"dev", "stable"}:
        raise ValueError("invalid release channel")
    notes = value["notes"]
    if not isinstance(notes, dict) or set(notes) != _NOTE_CATEGORIES:
        raise ValueError("invalid release note categories")
    for entries in notes.values():
        if not isinstance(entries, list) or len(entries) > 8:
            raise ValueError("release notes exceed the reviewed bound")
        for entry in entries:
            _text(entry, 240)
    supported = value["supportedUpgradeDigests"]
    if not isinstance(supported, list) or len(supported) > 32:
        raise ValueError("invalid supported upgrade images")
    if any(not isinstance(item, str) or not _DIGEST.fullmatch(item) for item in supported):
        raise ValueError("supported upgrades require immutable image digests")
    if len(set(supported)) != len(supported):
        raise ValueError("duplicate supported upgrade image")
    return value


def validate_release(value: object, *, target_image: str, environment: str) -> dict[str, Any]:
    if not isinstance(value, dict) or set(value) != {
        "schemaVersion",
        "descriptor",
        "image",
        "sourceRevision",
        "releasedAt",
        "publisher",
    }:
        raise ValueError("invalid pod release metadata")
    if type(value["schemaVersion"]) is not int or value["schemaVersion"] != 1:
        raise ValueError("unsupported release metadata version")
    descriptor = validate_descriptor(value["descriptor"])
    digest = image_digest(value["image"])
    if (
        not is_immutable_image_reference(value["image"])
        or not is_immutable_image_reference(target_image)
        or digest != image_digest(target_image)
    ):
        raise ValueError("release does not describe the selected immutable image")
    if not isinstance(value["sourceRevision"], str) or not _SHA.fullmatch(value["sourceRevision"]):
        raise ValueError("release requires a full source revision")
    released = datetime.fromisoformat(_text(value["releasedAt"], 40).replace("Z", "+00:00"))
    if released.tzinfo is None or released > datetime.now(timezone.utc):
        raise ValueError("invalid release publication time")
    publisher = value["publisher"]
    if not isinstance(publisher, dict) or set(publisher) != {"environment", "workflow", "runId"}:
        raise ValueError("invalid release provenance")
    expected = {"dev": ("dev", "deploy-dev"), "production": ("stable", "deploy-production")}
    if environment not in expected:
        raise ValueError("pod release publication is not enabled for this environment")
    channel, workflow = expected[environment]
    if (descriptor["channel"], publisher["environment"], publisher["workflow"]) != (
        channel,
        environment,
        workflow,
    ):
        raise ValueError("release channel does not match its deployment environment")
    if not isinstance(publisher["runId"], str) or not re.fullmatch(
        r"[1-9][0-9]{0,19}", publisher["runId"]
    ):
        raise ValueError("release requires workflow run provenance")
    if len(json.dumps(value).encode()) > MAX_RELEASE_BYTES:
        raise ValueError("release metadata exceeds its bound")
    return value


def configured_release(target_image: str) -> dict[str, Any] | None:
    encoded = os.getenv("HUSSH_ONE_POD_RELEASE_B64", "")
    if not encoded or len(encoded) > MAX_RELEASE_BYTES * 2:
        return None
    try:
        value = json.loads(base64.b64decode(encoded, validate=True))
        return validate_release(
            value, target_image=target_image, environment=os.getenv("HUSHH_DEPLOY_ENV", "")
        )
    except (ValueError, TypeError, binascii.Error):
        return None


def upgrade_is_supported(release: dict[str, Any] | None, installed_image: object) -> bool:
    if release is None:
        return False
    installed = image_digest(installed_image)
    return bool(installed and installed in release["descriptor"]["supportedUpgradeDigests"])


def approved_release(approval: object, target_image: str) -> dict[str, Any] | None:
    """Read the descriptor captured at approval, independently of newer offers."""
    if not isinstance(approval, dict):
        return None
    try:
        return validate_release(
            approval.get("releaseMetadata"),
            target_image=target_image,
            environment=os.getenv("HUSHH_DEPLOY_ENV", ""),
        )
    except (ValueError, TypeError):
        return None


def record_installed_release(
    metadata: dict[str, Any], release: dict[str, Any] | None
) -> dict[str, Any]:
    """Retain the selected label only when the provider recorded its digest."""
    installed = image_digest(metadata.get("image_digest") or metadata.get("image"))
    installed = installed or image_digest(metadata.get("source_image"))
    if release is not None and installed == image_digest(release["image"]):
        return {**metadata, "installedRelease": release}
    return metadata


def public_release(release: dict[str, Any]) -> dict[str, Any]:
    descriptor = release["descriptor"]
    return {
        "version": descriptor["version"],
        "summary": descriptor["summary"],
        "notes": descriptor["notes"],
        "releasedAt": release["releasedAt"],
    }
