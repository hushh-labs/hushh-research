# SPDX-License-Identifier: Apache-2.0
"""Declarative Gemini Live model compatibility registry."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal


@dataclass(frozen=True)
class GeminiLiveCompatibility:
    """Transport and relay requirements for one named Gemini Live model."""

    transport: Literal["vertex", "developer_api"]
    supports_mid_session_client_content: bool
    operator_enablement_required: bool


GEMINI_LIVE_COMPATIBILITY: dict[str, GeminiLiveCompatibility] = {
    "gemini-live-2.5-flash-native-audio": GeminiLiveCompatibility(
        transport="vertex",
        supports_mid_session_client_content=True,
        operator_enablement_required=False,
    ),
    "gemini-2.5-flash-live-preview": GeminiLiveCompatibility(
        transport="developer_api",
        supports_mid_session_client_content=True,
        operator_enablement_required=True,
    ),
    "gemini-3.1-flash-live-preview": GeminiLiveCompatibility(
        transport="developer_api",
        supports_mid_session_client_content=True,
        operator_enablement_required=True,
    ),
}
