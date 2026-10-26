# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hushh
"""Adapt the canonical operational reference to the existing phone rollback plan.

This retains original qualification evidence. Live admission revalidates runtime
identity and controls through their owner; it makes no new HTTP health claim.
"""

from __future__ import annotations

import copy
import importlib
import sys
from pathlib import Path
from typing import Any, Literal, TypedDict


class Binding(TypedDict):
    tag: dict[str, str]
    origin: dict[str, Any]
    uid: str
    runtime: dict[str, Any]


class Reference(TypedDict):
    mode: Literal["operational"]
    revision: str
    source: str
    image: str
    probe: dict[str, Any]
    operational_reference: Binding


def _owners():
    directory = str(Path(__file__).resolve().parents[2] / "scripts/ci")
    if directory not in sys.path:
        sys.path.insert(0, directory)
    return (
        importlib.import_module("production_backend_successor_proof"),
        importlib.import_module("production_backend_successor_control"),
    )


def current() -> Reference | None:
    proof, control = _owners()
    tag = proof.read_original()
    anchor = control.record_anchor(tag)
    # Only the authority owner's explicit absence result permits cold fallback.
    # Parsing, artifact, origin and live failures deliberately propagate.
    if anchor is None:
        return None
    control.live(anchor)
    selected: Reference = {
        "mode": "operational",
        "revision": anchor["revision"],
        "source": anchor["source"],
        "image": anchor["image"],
        "probe": anchor["sealed_boundary"]["checkpoint"]["plan"]["probe"],
        "operational_reference": {
            "tag": tag,
            "origin": anchor["origin"],
            "uid": anchor["uid"],
            "runtime": anchor["runtime"],
        },
    }
    return copy.deepcopy(selected)


def revalidate(plan: dict) -> dict:
    checked = current()
    if checked is None or any(plan.get(key) != value for key, value in checked.items()):
        raise ValueError("phone_rollback_operational_reference_changed")
    return {
        "mode": checked["mode"],
        "revision": checked["revision"],
        "source": checked["source"],
        "image": checked["image"],
        "uid": checked["operational_reference"]["uid"],
        "operational_reference": checked["operational_reference"],
        "recovery": False,
        "sso": False,
    }
