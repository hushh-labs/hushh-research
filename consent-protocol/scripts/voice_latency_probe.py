"""
Quick latency probe for Kai voice OpenAI calls.

Purpose:
- Measure raw OpenAI latency for intent planning models.
- Optionally measure raw STT latency for transcription models.
- Compare with in-app logs to identify whether bottleneck is model or app pipeline.

Examples:
  python scripts/voice_latency_probe.py --transcript "take me to profile"
  python scripts/voice_latency_probe.py --transcript "go to consent section" --runs 3
  python scripts/voice_latency_probe.py --transcript "analyze nvidia" --audio-file C:\\temp\\voice.webm
"""

from __future__ import annotations

import argparse
import json
import os
import time
from pathlib import Path
from typing import Any

import httpx
from dotenv import load_dotenv

_OPENAI_CHAT_URL = "https://api.openai.com/v1/chat/completions"
_OPENAI_TRANSCRIBE_URL = "https://api.openai.com/v1/audio/transcriptions"


def _parse_models(raw: str | None, defaults: list[str]) -> list[str]:
    values = raw.split(",") if raw else defaults
    out: list[str] = []
    seen: set[str] = set()
    for value in values:
        item = str(value or "").strip()
        if not item or item in seen:
            continue
        seen.add(item)
        out.append(item)
    return out


def _tools_schema() -> list[dict[str, Any]]:
    return [
        {
            "type": "function",
            "function": {
                "name": "execute_kai_command",
                "description": "Execute an existing Kai command action.",
                "parameters": {
                    "type": "object",
                    "additionalProperties": False,
                    "properties": {
                        "command": {
                            "type": "string",
                            "enum": [
                                "analyze",
                                "consent",
                                "dashboard",
                                "history",
                                "home",
                                "optimize",
                                "profile",
                            ],
                        },
                        "params": {
                            "type": "object",
                            "additionalProperties": False,
                            "properties": {
                                "symbol": {"type": "string"},
                                "focus": {"type": "string", "enum": ["active"]},
                                "tab": {
                                    "type": "string",
                                    "enum": ["history", "debate", "summary", "transcript"],
                                },
                            },
                        },
                    },
                    "required": ["command"],
                },
            },
        }
    ]


def _intent_prompt() -> str:
    return (
        "You are Kai voice intent planner. Output exactly one tool call. "
        "Handle STT misspellings. "
        "Map navigation: dashboard|portfolio->dashboard, analysis->history, "
        "market|kai|home->home, consent|consents|similar sounding words->consent, "
        "profile->profile. "
        "For analyze requests return analyze with params.symbol."
    )


def probe_intent(
    *,
    client: httpx.Client,
    api_key: str,
    model: str,
    transcript: str,
    run_idx: int,
) -> None:
    payload = {
        "model": model,
        "temperature": 0,
        "max_tokens": 120,
        "tool_choice": "required",
        "messages": [
            {"role": "system", "content": _intent_prompt()},
            {"role": "user", "content": json.dumps({"transcript": transcript, "context": {}})},
        ],
        "tools": _tools_schema(),
    }
    started = time.perf_counter()
    response = client.post(
        _OPENAI_CHAT_URL,
        headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
        json=payload,
        timeout=45.0,
    )
    elapsed_ms = int((time.perf_counter() - started) * 1000)
    data = response.json() if response.content else {}
    tool_call = None
    if isinstance(data, dict):
        choices = data.get("choices")
        if isinstance(choices, list) and choices:
            msg = choices[0].get("message") if isinstance(choices[0], dict) else None
            if isinstance(msg, dict):
                calls = msg.get("tool_calls")
                if isinstance(calls, list) and calls:
                    fn = calls[0].get("function") if isinstance(calls[0], dict) else None
                    if isinstance(fn, dict):
                        tool_call = {"name": fn.get("name"), "args": fn.get("arguments")}
    print(
        f"[INTENT] run={run_idx} model={model} status={response.status_code} elapsed_ms={elapsed_ms} tool_call={tool_call}"
    )


def probe_stt(
    *,
    client: httpx.Client,
    api_key: str,
    model: str,
    audio_file: Path,
    run_idx: int,
) -> None:
    audio_bytes = audio_file.read_bytes()
    files = {
        "file": (audio_file.name, audio_bytes, "application/octet-stream"),
    }
    started = time.perf_counter()
    response = client.post(
        _OPENAI_TRANSCRIBE_URL,
        headers={"Authorization": f"Bearer {api_key}"},
        data={"model": model},
        files=files,
        timeout=45.0,
    )
    elapsed_ms = int((time.perf_counter() - started) * 1000)
    data = response.json() if response.content else {}
    transcript = str(data.get("text") if isinstance(data, dict) else "")[:120]
    print(
        f"[STT] run={run_idx} model={model} status={response.status_code} elapsed_ms={elapsed_ms} bytes={len(audio_bytes)} transcript_preview={transcript!r}"
    )


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--transcript", required=True, help="Test transcript for intent planning.")
    parser.add_argument("--runs", type=int, default=1, help="Runs per model.")
    parser.add_argument(
        "--audio-file", type=str, default="", help="Optional audio file for STT probe."
    )
    args = parser.parse_args()

    repo_root = Path(__file__).resolve().parents[1]
    load_dotenv(repo_root / ".env", override=False)

    api_key = (os.getenv("OPENAI_API_KEY") or "").strip()
    if not api_key:
        raise SystemExit("OPENAI_API_KEY is missing in consent-protocol/.env")

    intent_models = _parse_models(
        os.getenv("OPENAI_VOICE_INTENT_MODELS"),
        defaults=[
            (os.getenv("OPENAI_VOICE_INTENT_MODEL") or "gpt-4.1-nano").strip(),
            "gpt-4o-mini",
            "gpt-4.1-mini",
        ],
    )
    stt_models = _parse_models(
        os.getenv("OPENAI_VOICE_STT_MODELS"),
        defaults=[
            (os.getenv("OPENAI_VOICE_STT_MODEL") or "gpt-4o-mini-transcribe").strip(),
            "whisper-1",
        ],
    )

    print(f"Intent models: {intent_models}")
    print(f"STT models: {stt_models}")
    print(f"Runs per model: {args.runs}")

    with httpx.Client() as client:
        for model in intent_models:
            for run_idx in range(1, args.runs + 1):
                probe_intent(
                    client=client,
                    api_key=api_key,
                    model=model,
                    transcript=args.transcript,
                    run_idx=run_idx,
                )

        if args.audio_file:
            audio_path = Path(args.audio_file).expanduser().resolve()
            if not audio_path.exists():
                raise SystemExit(f"Audio file not found: {audio_path}")
            for model in stt_models:
                for run_idx in range(1, args.runs + 1):
                    probe_stt(
                        client=client,
                        api_key=api_key,
                        model=model,
                        audio_file=audio_path,
                        run_idx=run_idx,
                    )


if __name__ == "__main__":
    main()
