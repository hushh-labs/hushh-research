"""Shared plumbing for the Azure OpenAI harness runs (in-Azure edition, Responses API).

What is substituted, and nothing else in the model path:

1. Credential. In Azure (the default) NOTHING is patched: the pod's own
   ``azure_openai.workload_token_provider()`` mints the token from the platform's
   ``IDENTITY_ENDPOINT`` for ``AZURE_CLIENT_ID``, exactly as a ``user_azure_mi`` pod
   does. Only ``EVAL_CREDENTIAL=az_cli`` (a laptop smoke test) swaps in the signed-in
   user's Entra token, and every record says which path produced it.
2. Measurement. A wrapper around the OpenAI SDK's ``responses.create`` records usage,
   the effort the response reports, timing, and every HTTP attempt underneath it (so a
   429 the SDK retried silently is visible and its wait is not mistaken for model
   latency).
3. Reasoning level (``EVAL_REASONING``): ``production`` sends what the transport
   derived from the agent's thinking config; ``default`` removes ``reasoning`` so the
   deployment's own default applies; ``none|minimal|low|medium|high`` sets that effort.
   The transport's own choice is recorded beside what was sent.
"""

from __future__ import annotations

import contextvars
import json
import os
import subprocess
import sys
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

REPO = Path(os.environ.get("EVAL_REPO_ROOT") or Path(__file__).resolve().parents[2])
if str(REPO) not in sys.path:
    sys.path.insert(0, str(REPO))

ENDPOINT = "https://hussh-aoai-eval-268e88.openai.azure.com/"
OUT_ROOT = Path(os.environ.get("EVAL_OUT_ROOT") or (Path(__file__).parent / "artifacts"))
REASONING = (os.environ.get("EVAL_REASONING") or "production").strip().lower()
_REASONING_CHOICES = {"production", "default", "none", "minimal", "low", "medium", "high"}
if REASONING not in _REASONING_CHOICES:
    raise SystemExit(f"EVAL_REASONING must be one of {sorted(_REASONING_CHOICES)}")
CREDENTIAL = "az_cli" if os.environ.get("EVAL_CREDENTIAL") == "az_cli" else "managed_identity"
CODE_SHA = os.environ.get("EVAL_CODE_SHA", "")

_lock = threading.Lock()
_token: dict[str, Any] = {"value": "", "exp": 0.0}
_CURRENT: contextvars.ContextVar["CallRecord | None"] = contextvars.ContextVar(
    "hussh_eval_call", default=None
)


def out_dir(label: str) -> Path:
    path = OUT_ROOT / label
    path.mkdir(parents=True, exist_ok=True)
    return path


def _az_token() -> str:
    with _lock:
        if _token["value"] and time.time() < _token["exp"] - 300:
            return _token["value"]
        out = subprocess.run(
            [
                "az",
                "account",
                "get-access-token",
                "--resource",
                "https://cognitiveservices.azure.com",
                "--query",
                "{t:accessToken,e:expires_on}",
                "-o",
                "json",
            ],
            capture_output=True,
            text=True,
            check=True,
        )
        data = json.loads(out.stdout)
        _token["value"] = data["t"]
        _token["exp"] = float(data["e"])
        return _token["value"]


@dataclass
class CallRecord:
    model: str
    stream: bool
    started: float
    credential: str = CREDENTIAL
    elapsed_ms: float = 0.0
    headers_ms: float | None = None
    first_event_ms: float | None = None
    first_output_ms: float | None = None
    input_tokens: int | None = None
    cached_tokens: int | None = None
    output_tokens: int | None = None
    reasoning_tokens: int | None = None
    transport_effort: str | None = None
    sent_effort: str | None = None
    reported_effort: str | None = None
    response_model: str | None = None
    status: str | None = None
    incomplete_reason: str | None = None
    error_status: int | None = None
    error_code: str | None = None
    error_message: str | None = None
    n_tools: int = 0
    store: Any = None
    attempts: list[dict] = field(default_factory=list)


@dataclass
class UsageLog:
    calls: list[CallRecord] = field(default_factory=list)

    def mark(self) -> int:
        return len(self.calls)

    def since(self, mark: int) -> list[CallRecord]:
        return self.calls[mark:]


USAGE = UsageLog()


def _ms(rec: CallRecord) -> float:
    return (time.perf_counter() - rec.started) * 1000


def _from_response(rec: CallRecord, response: Any) -> None:
    if response is None:
        return
    usage = getattr(response, "usage", None)
    if usage is not None:
        rec.input_tokens = getattr(usage, "input_tokens", None)
        rec.output_tokens = getattr(usage, "output_tokens", None)
        details = getattr(usage, "input_tokens_details", None)
        rec.cached_tokens = getattr(details, "cached_tokens", None) if details else None
        details = getattr(usage, "output_tokens_details", None)
        rec.reasoning_tokens = getattr(details, "reasoning_tokens", None) if details else None
    reasoning = getattr(response, "reasoning", None)
    if reasoning is not None:
        rec.reported_effort = getattr(reasoning, "effort", None)
    rec.response_model = getattr(response, "model", None) or rec.response_model
    rec.status = getattr(response, "status", None) or rec.status
    incomplete = getattr(response, "incomplete_details", None)
    if incomplete is not None:
        rec.incomplete_reason = getattr(incomplete, "reason", None)


_OUTPUT_EVENTS = {
    "response.output_text.delta",
    "response.function_call_arguments.delta",
    "response.output_item.added",
}


class _StreamWrap:
    def __init__(self, inner: Any, rec: CallRecord):
        self._inner = inner
        self._rec = rec

    def __aiter__(self):
        return self._gen()

    async def _gen(self):
        try:
            async for event in self._inner:
                kind = getattr(event, "type", "")
                if self._rec.first_event_ms is None:
                    self._rec.first_event_ms = _ms(self._rec)
                if self._rec.first_output_ms is None and kind in _OUTPUT_EVENTS:
                    item = getattr(event, "item", None)
                    if kind != "response.output_item.added" or getattr(item, "type", "") in {
                        "function_call",
                        "message",
                    }:
                        self._rec.first_output_ms = _ms(self._rec)
                if kind in {"response.completed", "response.incomplete", "response.failed"}:
                    _from_response(self._rec, getattr(event, "response", None))
                elif kind == "error":
                    self._rec.error_code = str(getattr(event, "code", "") or "")[:80]
                    self._rec.error_message = str(getattr(event, "message", "") or "")[:400]
                yield event
        finally:
            self._rec.elapsed_ms = _ms(self._rec)


def _install_attempt_log() -> None:
    import httpx

    if getattr(httpx.AsyncClient.send, "_hussh_wrapped", False):
        return
    original = httpx.AsyncClient.send

    async def send(self, request, *args, **kwargs):  # type: ignore[no-untyped-def]
        rec = _CURRENT.get()
        host = request.url.host or ""
        watched = rec is not None and host.endswith(".openai.azure.com")
        started = time.perf_counter()
        try:
            response = await original(self, request, *args, **kwargs)
        except Exception as exc:
            if watched:
                rec.attempts.append(
                    {
                        "status": None,
                        "ms": (time.perf_counter() - started) * 1000,
                        "error": type(exc).__name__,
                    }
                )
            raise
        if watched:
            h = response.headers
            rec.attempts.append(
                {
                    "status": response.status_code,
                    "ms": (time.perf_counter() - started) * 1000,
                    "region": h.get("x-ms-region"),
                    "retry_after_ms": h.get("retry-after-ms") or h.get("retry-after"),
                    "remaining_tokens": h.get("x-ratelimit-remaining-tokens"),
                    "remaining_requests": h.get("x-ratelimit-remaining-requests"),
                }
            )
        return response

    send._hussh_wrapped = True  # type: ignore[attr-defined]
    httpx.AsyncClient.send = send


def install() -> None:
    """Select the credential, then wrap the SDK's Responses create() for measurement."""
    from openai.resources import responses as rr

    from hushh_mcp.runtime_providers import azure_openai

    if CREDENTIAL == "az_cli":
        azure_openai.workload_token_provider = lambda: _az_token  # laptop smoke only
    else:
        missing = [
            n
            for n in ("IDENTITY_ENDPOINT", "IDENTITY_HEADER", "AZURE_CLIENT_ID")
            if not os.environ.get(n)
        ]
        if missing:
            raise SystemExit(f"not an Azure workload (missing {missing}); refusing to run")
    _install_attempt_log()
    if getattr(rr.AsyncResponses.create, "_hussh_wrapped", False):
        return
    original = rr.AsyncResponses.create

    async def create(self, *args, **kwargs):  # type: ignore[no-untyped-def]
        transport_effort = (kwargs.get("reasoning") or {}).get("effort")
        if REASONING == "default":
            kwargs.pop("reasoning", None)
        elif REASONING != "production":
            kwargs["reasoning"] = {"effort": REASONING}
        stream = bool(kwargs.get("stream"))
        rec = CallRecord(
            model=str(kwargs.get("model")),
            stream=stream,
            started=time.perf_counter(),
            n_tools=len(kwargs.get("tools") or []),
            store=kwargs.get("store"),
            transport_effort=transport_effort,
            sent_effort=(kwargs.get("reasoning") or {}).get("effort"),
        )
        USAGE.calls.append(rec)
        token = _CURRENT.set(rec)
        try:
            result = await original(self, *args, **kwargs)
        except Exception as exc:
            rec.elapsed_ms = _ms(rec)
            rec.error_status = getattr(exc, "status_code", None)
            body = getattr(exc, "body", None)
            if isinstance(body, dict):
                rec.error_code = str(body.get("code") or "")[:80]
                rec.error_message = str(body.get("message") or "")[:400]
            else:
                rec.error_message = type(exc).__name__
            raise
        finally:
            _CURRENT.reset(token)
        rec.headers_ms = _ms(rec)
        if stream:
            return _StreamWrap(result, rec)
        rec.elapsed_ms = rec.headers_ms
        _from_response(rec, result)
        return result

    create._hussh_wrapped = True  # type: ignore[attr-defined]
    rr.AsyncResponses.create = create


def set_topology(deployment: str) -> None:
    rendered = os.environ.get("AZURE_OPENAI_ENDPOINT")
    if rendered and rendered != ENDPOINT:
        raise SystemExit(f"unexpected AZURE_OPENAI_ENDPOINT {rendered!r}")
    os.environ["AZURE_OPENAI_ENDPOINT"] = ENDPOINT
    os.environ["AZURE_OPENAI_DEPLOYMENT"] = deployment


def run_meta(deployment: str) -> dict:
    return {
        "deployment": deployment,
        "reasoning_setting": REASONING,
        "credential": CREDENTIAL,
        "code_sha": CODE_SHA,
        "in_azure": bool(os.environ.get("IDENTITY_ENDPOINT")),
        "job_execution": os.environ.get("CONTAINER_APP_JOB_EXECUTION_NAME"),
        "pod_image_tag": os.environ.get("HUSSH_POD_IMAGE_TAG"),
        "drivers_sha256": os.environ.get("EVAL_DRIVERS_SHA256_VERIFIED"),
    }


def patch_git(module: Any) -> None:
    """The image carries no git and no .git: answer the harness's provenance calls."""
    if not CODE_SHA:
        return
    real = subprocess.run

    def run(cmd, *args, **kwargs):  # type: ignore[no-untyped-def]
        if isinstance(cmd, (list, tuple)) and list(cmd[:1]) == ["git"]:
            if list(cmd[1:3]) == ["rev-parse", "HEAD"]:
                return subprocess.CompletedProcess(cmd, 0, stdout=CODE_SHA + "\n", stderr="")
            if list(cmd[1:3]) == ["status", "--porcelain"]:
                return subprocess.CompletedProcess(cmd, 0, stdout="", stderr="")
        return real(cmd, *args, **kwargs)

    module.subprocess = type(
        "SubprocessShim",
        (),
        {
            "run": staticmethod(run),
            "SubprocessError": subprocess.SubprocessError,
            "CompletedProcess": subprocess.CompletedProcess,
        },
    )


# List prices per 1M tokens (input / cached input / output), Azure Retail Prices API,
# Global Standard, eastus2. Re-checked by fetch_prices.py on the day of the run.
PRICES = {
    "gpt-5-mini": {"in": 0.25, "cached": 0.025, "out": 2.00},
    "gpt-6-luna": {"in": 0.10, "cached": 0.01, "out": 0.50},
    "gpt-5.6-luna": {"in": 0.20, "cached": 0.02, "out": 1.20},
}


def cost_usd(model: str, calls: list[CallRecord]) -> float | None:
    price = PRICES.get(model)
    if price is None:
        return None
    total = 0.0
    for c in calls:
        if c.input_tokens is None or c.output_tokens is None:
            return None
        cached = c.cached_tokens or 0
        total += (c.input_tokens - cached) * price["in"] / 1e6
        total += cached * price["cached"] / 1e6
        total += c.output_tokens * price["out"] / 1e6
    return total
