"""Environment contract for One Live Voice.

One explicit model id, one regional Vertex location, one server-side flag.
There are no aliases and no fallbacks: when the flag is on and the model or
location is missing or malformed, the process fails closed by naming the
variable, never by picking a different model.
"""

from __future__ import annotations

import os
import re
from dataclasses import dataclass
from typing import Final

ONE_VOICE_LIVE_ENABLED_ENV = "ONE_VOICE_LIVE_ENABLED"
VERTEX_LIVE_MODEL_ID_ENV = "VERTEX_LIVE_MODEL_ID"
VERTEX_LIVE_LOCATION_ENV = "VERTEX_LIVE_LOCATION"
ONE_VOICE_MAX_SESSIONS_PER_INSTANCE_ENV = "ONE_VOICE_MAX_SESSIONS_PER_INSTANCE"
ONE_VOICE_SESSION_MAX_MINUTES_ENV = "ONE_VOICE_SESSION_MAX_MINUTES"
ONE_VOICE_IDLE_CLOSE_SECONDS_ENV = "ONE_VOICE_IDLE_CLOSE_SECONDS"
ONE_VOICE_DAILY_MINUTES_PER_USER_ENV = "ONE_VOICE_DAILY_MINUTES_PER_USER"

PROTOCOL_VERSION: Final = "one-voice-v1"

_TRUE_VALUES = frozenset({"1", "true", "yes", "on"})
_MODEL_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$")
# Live models are served from regional endpoints only. The multi-region
# aliases the text fleet uses (global/us/eu) are rejected on purpose.
_REGIONAL_LOCATION_RE = re.compile(r"^[a-z]+-[a-z]+[0-9]+$")


class OneVoiceConfigError(RuntimeError):
    """Raised when the flag is on but the contract is incomplete."""


def _clean(name: str) -> str:
    return str(os.getenv(name) or "").strip()


def _positive_int(name: str, default: int) -> int:
    raw = _clean(name)
    if not raw:
        return default
    try:
        value = int(raw)
    except ValueError as exc:
        raise OneVoiceConfigError(f"{name} must be a positive integer") from exc
    if value <= 0:
        raise OneVoiceConfigError(f"{name} must be a positive integer")
    return value


@dataclass(frozen=True)
class OneVoiceLiveConfig:
    enabled: bool
    model_id: str
    location: str
    max_sessions_per_instance: int = 8
    session_max_minutes: int = 30
    idle_close_seconds: int = 90
    daily_minutes_per_user: int = 30

    @classmethod
    def from_environment(cls) -> OneVoiceLiveConfig:
        """Read the contract at call time so a Cloud Run env change takes effect
        without a code change (the flag doubles as the kill switch)."""
        enabled = _clean(ONE_VOICE_LIVE_ENABLED_ENV).lower() in _TRUE_VALUES
        if not enabled:
            # Disabled: never touch the model contract, never construct a client.
            return cls(enabled=False, model_id="", location="")
        model_id = _clean(VERTEX_LIVE_MODEL_ID_ENV)
        if not model_id or not _MODEL_ID_RE.fullmatch(model_id):
            raise OneVoiceConfigError(
                f"{VERTEX_LIVE_MODEL_ID_ENV} must name one explicit Vertex Live model id"
            )
        location = _clean(VERTEX_LIVE_LOCATION_ENV).lower()
        if not location or not _REGIONAL_LOCATION_RE.fullmatch(location):
            raise OneVoiceConfigError(
                f"{VERTEX_LIVE_LOCATION_ENV} must be one regional Vertex location "
                "(for example us-central1); global/us/eu are not Live endpoints"
            )
        return cls(
            enabled=True,
            model_id=model_id,
            location=location,
            max_sessions_per_instance=_positive_int(
                ONE_VOICE_MAX_SESSIONS_PER_INSTANCE_ENV, cls.max_sessions_per_instance
            ),
            session_max_minutes=_positive_int(
                ONE_VOICE_SESSION_MAX_MINUTES_ENV, cls.session_max_minutes
            ),
            idle_close_seconds=_positive_int(
                ONE_VOICE_IDLE_CLOSE_SECONDS_ENV, cls.idle_close_seconds
            ),
            daily_minutes_per_user=_positive_int(
                ONE_VOICE_DAILY_MINUTES_PER_USER_ENV, cls.daily_minutes_per_user
            ),
        )

    @property
    def session_max_seconds(self) -> int:
        return self.session_max_minutes * 60


def live_voice_enabled() -> bool:
    return _clean(ONE_VOICE_LIVE_ENABLED_ENV).lower() in _TRUE_VALUES
