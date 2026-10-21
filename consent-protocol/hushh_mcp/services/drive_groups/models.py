"""The data the aid runs on: group definitions, three signal models and the fusion policy.

All five files live in ``data/`` beside this module and are produced by
``scripts/train_drive_groups.py`` from labelled examples. Their combined hash is
the version recorded on every placement, so a stored placement can always be
traced to the data that made it. Loading validates every number and shape.
"""

from __future__ import annotations

import hashlib
import json
from collections.abc import Mapping
from dataclasses import dataclass
from functools import lru_cache
from importlib import resources

from hushh_mcp.services.drive_groups.contract import GROUP_IDS
from hushh_mcp.services.drive_groups.embedding_model import EmbeddingModel
from hushh_mcp.services.drive_groups.fusion import FusionPolicy
from hushh_mcp.services.drive_groups.linear_model import LinearModel
from hushh_mcp.services.drive_groups.text_head import HEAD_CHARS, MAX_HEAD_CHARS, MIN_HEAD_CHARS

DATA_FILES = (
    "groups.json",
    "text_model.json",
    "metadata_model.json",
    "embedding_model.json",
    "fusion.json",
)


@dataclass(frozen=True, slots=True)
class ModelBundle:
    text: LinearModel
    metadata: LinearModel
    embedding: EmbeddingModel
    fusion: FusionPolicy
    definitions: Mapping[str, str]
    head_chars: int
    version: str

    @classmethod
    def from_payloads(cls, payloads: Mapping[str, object], version: str) -> ModelBundle:
        groups = payloads["groups.json"]
        if not isinstance(groups, dict) or groups.get("kind") != "groups_v1":
            raise ValueError("invalid groups file")
        definitions, head_chars = groups.get("groups"), groups.get("head_chars", HEAD_CHARS)
        if (
            not isinstance(definitions, dict)
            or set(definitions) != set(GROUP_IDS)
            or any(
                not isinstance(text, str) or not 10 <= len(text) <= 600
                for text in definitions.values()
            )
            or type(head_chars) is not int
            or not MIN_HEAD_CHARS <= head_chars <= MAX_HEAD_CHARS
        ):
            raise ValueError("invalid groups file")
        return cls(
            text=LinearModel.from_payload(payloads["text_model.json"]),
            metadata=LinearModel.from_payload(payloads["metadata_model.json"]),
            embedding=EmbeddingModel.from_payload(payloads["embedding_model.json"]),
            fusion=FusionPolicy.from_payload(payloads["fusion.json"]),
            definitions=dict(definitions),
            head_chars=head_chars,
            version=version,
        )


def version_of(raw: Mapping[str, bytes]) -> str:
    digest = hashlib.sha256()
    for name in DATA_FILES:
        digest.update(name.encode() + b"\0" + raw[name] + b"\0")
    return digest.hexdigest()[:12]


@lru_cache(maxsize=1)
def load_bundle() -> ModelBundle:
    """Read, validate and cache the packaged data files."""
    base = resources.files(__package__).joinpath("data")
    raw = {name: base.joinpath(name).read_bytes() for name in DATA_FILES}
    return ModelBundle.from_payloads({name: json.loads(raw[name]) for name in raw}, version_of(raw))
