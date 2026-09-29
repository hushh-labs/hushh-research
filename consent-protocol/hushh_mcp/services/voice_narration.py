"""Speak a validated short digest, without the operational model holding it.

One Live Voice's model cannot do this. Measured 2026-09-29 against the deployed
Live id: ``gemini-live-2.5-flash-native-audio`` answers ``generateContent`` with
400 ``"not supported in the generateContent API"``. It is reachable only through
``live.connect``, and everything sent there enters the session's own history --
which is the boundary a mail digest must not cross, because the session keeps
provider-side compressed context and a resumption handle for hours.

So narration runs on a second model, in a context of its own:
``gemini-2.5-flash-preview-tts``, which accepts ``generateContent`` with an AUDIO
response modality and returns ``audio/L16;codec=pcm;rate=24000`` -- the same
PCM16 at 24 kHz the client already plays, so the existing player needs no new
format. Same provider, same project, same ADC, same voice.

What this context is not allowed to be:

* It has no tools, no function declarations and no conversation history. Its only
  output is audio. A sentence inside a digest that tries to issue an instruction
  has nothing here to act on.
* It never sees Gmail credentials, an owner token, a session id or a resumption
  handle. It is handed one short string.
* Its output is audio only. Nothing it produces is fed back to the operational
  model, and the caller is responsible for keeping it out of ``spoken_facts``,
  transcripts and app context.

"A model processes the digest" is true and is the honest claim. The boundary is
that mail-derived text never reaches a model that can *select an operation*.
"""

from __future__ import annotations

import asyncio
import logging
import re
from collections.abc import AsyncIterator
from dataclasses import dataclass

logger = logging.getLogger(__name__)

# The model measured to serve generateContent with an AUDIO modality. Held here
# as a constant rather than an env var: it is a capability fact about the API,
# not a deployment choice, and pointing it at the Live id silently would produce
# a 400 on every narration.
NARRATION_MODEL = "gemini-2.5-flash-preview-tts"
# Both locations accepted in the measurement. us-central1 matches the Live
# session's region, which keeps one narration in the same place as the turn.
NARRATION_LOCATION = "us-central1"

# A digest, not a message. Long enough for a few sentences of findings and far
# short of a body: this bound is what stops a "read it all out" from arriving
# through narration after the read path refused it.
MAX_DIGEST_CHARS = 700
# 24 kHz mono PCM16 is 48000 bytes a second, so this is roughly 30 seconds. A
# narration longer than that is a readout, which is a different feature.
MAX_AUDIO_BYTES = 1_500_000
NARRATION_TIMEOUT_SECONDS = 30.0

_OUTPUT_MIME_PREFIX = "audio/l16"
# The only rate the player can schedule. `protocol.audio_out` hardcodes
# `rate=24000` and the client never reads the mime type at all -- it builds the
# buffer at its own `OUTPUT_SAMPLE_RATE` constant. So a narration at any other
# rate does not fail, it plays too fast or too slow, which is a defect nobody
# would report as an audio bug. Refused here, at the only place that knows.
PLAYER_SAMPLE_RATE = 24000
# Control characters, and the bracketed markup a text-to-speech model may read as
# a directive rather than as words. The digest is prose the person will hear.
_UNSPEAKABLE = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f<>]")


class NarrationUnavailable(RuntimeError):
    """Narration did not happen. The visible result is unaffected."""

    def __init__(self, reason: str):
        super().__init__(reason)
        self.reason = reason


@dataclass(frozen=True)
class Narration:
    """Audio for the player, and nothing the model may see."""

    audio: bytes
    mime_type: str
    sample_rate: int
    characters: int


def narratable(text: str) -> str:
    """The digest as it will be spoken, or empty when there is nothing to say.

    Bounded and stripped here rather than at the call site, so every caller gets
    the same rule and a longer digest cannot become a body readout by arriving
    through a different path.
    """
    clean = _UNSPEAKABLE.sub(" ", str(text or "")).strip()
    clean = re.sub(r"\s+", " ", clean)
    return clean[:MAX_DIGEST_CHARS]


async def narrate_digest(
    text: str,
    *,
    voice_name: str,
    binding_factory=None,
    model: str = NARRATION_MODEL,
    location: str = NARRATION_LOCATION,
) -> Narration:
    """Render one short digest to PCM the existing player can enqueue.

    ``voice_name`` is the session's own selected voice, so the person hears one
    voice rather than two. Raises ``NarrationUnavailable``; a failed narration
    leaves the visible result exactly as it was, because the screen and the
    speaker are separate outcomes.
    """
    chunks: list[bytes] = []
    mime = ""
    rate = 0
    spoken_chars = 0
    async for piece in narrate_digest_stream(
        text,
        voice_name=voice_name,
        binding_factory=binding_factory,
        model=model,
        location=location,
    ):
        chunks.append(piece.audio)
        mime = piece.mime_type
        rate = piece.sample_rate
        spoken_chars = piece.characters
    if not chunks:
        raise NarrationUnavailable("no_audio")
    return Narration(
        audio=b"".join(chunks),
        mime_type=mime,
        sample_rate=rate,
        characters=spoken_chars,
    )


async def narrate_digest_stream(
    text: str,
    *,
    voice_name: str,
    binding_factory=None,
    model: str = NARRATION_MODEL,
    location: str = NARRATION_LOCATION,
) -> AsyncIterator[Narration]:
    """Yield PCM chunks as they arrive, so speech can start before it is finished.

    Measured 2026-09-29: waiting for the whole utterance costs 8.9s before the
    first sound for a 143-character digest, which is a silence nobody would wait
    through mid-conversation. Streaming the same digest gives first audio in 2.5s
    and finishes generating in 7.0s for 8.2s of speech -- generation outruns
    playback, so the gap the person hears is the first chunk only.

    Each chunk is shaped for the existing player, which already schedules gapless
    PCM on the audio clock. The byte ceiling is enforced across the whole stream,
    so a runaway generation is cut rather than buffered.
    """
    spoken = narratable(text)
    if not spoken:
        raise NarrationUnavailable("empty_digest")

    if binding_factory is None:
        from hushh_mcp.runtime_providers.factory import ManagedGeminiRuntimeBinding

        binding_factory = ManagedGeminiRuntimeBinding.from_environment

    try:
        from google.genai import types as genai_types
    except Exception as exc:  # noqa: BLE001 - absent SDK is an unavailable feature
        raise NarrationUnavailable("sdk_missing") from exc

    try:
        client = binding_factory().build_direct_client(
            location=location,
            http_options=genai_types.HttpOptions(timeout=int(NARRATION_TIMEOUT_SECONDS * 1000)),
        )
        # Read through the module so a test can shorten it, and so a hosted
        # change does not need this coroutine rebuilt.
        config = genai_types.GenerateContentConfig(
            response_modalities=["AUDIO"],
            speech_config=genai_types.SpeechConfig(
                voice_config=genai_types.VoiceConfig(
                    prebuilt_voice_config=genai_types.PrebuiltVoiceConfig(voice_name=voice_name)
                )
            ),
        )
        emitted = 0
        seen_audio = False
        async with asyncio.timeout(_timeout_seconds()):
            stream = await client.aio.models.generate_content_stream(
                model=model, contents=spoken, config=config
            )
            async for response in stream:
                audio, mime = _first_audio(response)
                if not audio:
                    continue
                if not mime.lower().startswith(_OUTPUT_MIME_PREFIX):
                    raise NarrationUnavailable("unsupported_format")
                if _rate_of(mime) != PLAYER_SAMPLE_RATE:
                    # Heard as a refusal rather than as chipmunk audio.
                    raise NarrationUnavailable("unsupported_sample_rate")
                emitted += len(audio)
                if emitted > MAX_AUDIO_BYTES:
                    # A narration this long is a readout, which is a different
                    # feature. Cut the stream rather than buffer it.
                    raise NarrationUnavailable("audio_too_large")
                seen_audio = True
                yield Narration(
                    audio=audio,
                    mime_type=mime,
                    sample_rate=_rate_of(mime),
                    characters=len(spoken),
                )
    except NarrationUnavailable:
        raise
    except TimeoutError as exc:
        raise NarrationUnavailable("timeout") from exc
    except Exception as exc:  # noqa: BLE001
        # Provider messages can carry request echoes; the reason code is authored
        # here and the detail is never surfaced or logged.
        logger.warning("Voice narration failed: %s", type(exc).__name__)
        raise NarrationUnavailable("provider_unavailable") from None
    if not seen_audio:
        raise NarrationUnavailable("no_audio")


def _timeout_seconds() -> float:
    return float(NARRATION_TIMEOUT_SECONDS)


def _first_audio(response) -> tuple[bytes, str]:
    for candidate in getattr(response, "candidates", None) or []:
        content = getattr(candidate, "content", None)
        for part in getattr(content, "parts", None) or []:
            inline = getattr(part, "inline_data", None)
            data = getattr(inline, "data", None) if inline is not None else None
            if data:
                return bytes(data), str(getattr(inline, "mime_type", "") or "")
    return b"", ""


def _rate_of(mime: str) -> int:
    """The sample rate the provider actually returned, not an assumed one.

    The player schedules on this; taking it from the response rather than from a
    constant means a provider change is heard as a refusal, not as chipmunk audio.
    """
    match = re.search(r"rate=(\d{4,6})", mime)
    return int(match.group(1)) if match else 0
