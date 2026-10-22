"""Operon core: one file's evidence in, one placement out. Pure and synchronous."""

from __future__ import annotations

from hushh_mcp.services.drive_groups.contract import FileEvidence, Placement, SignalReading
from hushh_mcp.services.drive_groups.features import metadata_features, text_features
from hushh_mcp.services.drive_groups.fusion import fuse
from hushh_mcp.services.drive_groups.models import ModelBundle


def readings_for(evidence: FileEvidence, bundle: ModelBundle) -> tuple[SignalReading, ...]:
    """The three signals; each is unavailable when its evidence is missing."""
    text = bundle.text.probabilities(text_features(evidence.head)) if evidence.head else None
    embedding = (
        bundle.embedding.probabilities(evidence.vector) if evidence.vector is not None else None
    )
    metadata = bundle.metadata.probabilities(
        metadata_features(
            evidence.name,
            evidence.mime_type,
            owned_by_me=evidence.owned_by_me,
            shared_with_me=evidence.shared_with_me,
        )
    )
    return (
        SignalReading("text", text),
        SignalReading("embedding", embedding),
        SignalReading("metadata", metadata),
    )


def place(evidence: FileEvidence, bundle: ModelBundle) -> Placement:
    return fuse(readings_for(evidence, bundle), bundle.fusion, bundle.version)
