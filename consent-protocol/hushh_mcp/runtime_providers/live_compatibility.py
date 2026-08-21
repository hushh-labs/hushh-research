# SPDX-License-Identifier: Apache-2.0
"""Declarative Gemini Live model compatibility registry.

Lives in runtime_providers (dependency-light) rather than one_adk so the
deploy-time managed-runtime verifier can read the matrix without importing
the full agent tree, whose import chain requires app security configuration
(APP_SIGNING_KEY et al.) that the verifier job does not carry.

The relay injects redacted route state and correlated action settlements after
setup, so every model here must support mid-session injection. On 2.x live
models that channel is send_client_content; on 3.x live model names google-adk
transposes the same queue.send_content calls into send_realtime_input(text=...)
(single non-partial text part), so the flag means "the relay's mid-session
injections reach the model", whichever wire channel carries them. Keep the
model differences declarative: adding a model is an explicit contract decision
plus an ADK rehearsal, never a best-effort name-prefix heuristic.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal


@dataclass(frozen=True)
class GeminiLiveCompatibility:
    """One relay requirements for one named Gemini Live model contract."""

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
    # Canonical since 2026-08-21. Rehearsed on the Developer API: BIDI audio
    # setup, initial + MID-SESSION send_client_content, and mid-session
    # send_realtime_input(text=...) all elicited complete model turns. Not
    # served on Vertex (publisher endpoint 404s across regions), hence
    # developer_api transport with the Hussh-managed live key.
    "gemini-3.1-flash-live-preview": GeminiLiveCompatibility(
        transport="developer_api",
        supports_mid_session_client_content=True,
        operator_enablement_required=True,
    ),
}
