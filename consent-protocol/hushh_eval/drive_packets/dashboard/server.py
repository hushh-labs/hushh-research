"""Local dashboard server: one owner (Manish), read-only UAT, bound to 127.0.0.1 only.

Every route reads through the owner-bound data layer; the only writes are the
founder's own labels (and dry-run ask records) in the private dashboard
directory. Requests must name this machine as Host (a DNS-rebinding page is
refused), and a POST must be JSON from this page's own origin. The request engine
(``dashboard.ask``) is optional: without it /api/ask and /api/presets answer 503.
"""

from __future__ import annotations

import asyncio
import importlib
import inspect
import logging
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Literal

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse
from pydantic import BaseModel, ConfigDict, Field, ValidationError
from starlette.concurrency import run_in_threadpool
from starlette.staticfiles import StaticFiles

from hushh_eval.drive_packets.dashboard.accuracy import packet_accuracy, request_accuracy
from hushh_eval.drive_packets.dashboard.labels import SAFE_ID, LabelError
from hushh_eval.drive_packets.dashboard.owner import OwnerConfig
from hushh_eval.drive_packets.dashboard.queries import PacketNotFound
from hushh_eval.drive_packets.dashboard.real_requests import RequestNotFound
from hushh_eval.drive_packets.sources import ReadOnlyViolation

logger = logging.getLogger("hushh_eval.dashboard")

BIND_HOST = "127.0.0.1"
STATIC_DIR = Path(__file__).resolve().parent / "static"
ASK_MODULE = "hushh_eval.drive_packets.dashboard.ask"
STRIPE_NOTICE = (
    "UAT checkout uses live Stripe keys: a real request you pay for in the app charges real money."
)
DRY_RUN_NOTICE = (
    "Dry run: the deployed engine runs in this process, reading UAT and Drive only. "
    "Nothing is written to UAT, Drive or Stripe, and nothing is shared or sent; "
    "'Chris' is simulated."
)
SECURITY_HEADERS = {
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "X-Frame-Options": "DENY",
    "Content-Security-Policy": (
        "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; "
        "img-src 'self' data:; font-src 'self'; base-uri 'none'; form-action 'none'; "
        "frame-ancestors 'none'"
    ),
}
DAY = r"^\d{4}-\d{2}-\d{2}$"


class BindRefused(RuntimeError):
    """The dashboard binds 127.0.0.1 only."""


class Unavailable(Exception):
    """A part of the dashboard is not running (UAT down, engine not installed): a 503."""


class PacketLabelBody(BaseModel):
    model_config = ConfigDict(extra="forbid")
    verdict: Literal["correct", "wrong", "unsure"]
    reason: str | None = Field(default=None, max_length=64)
    note: str | None = Field(default=None, max_length=2000)


class DocumentLabelBody(BaseModel):
    model_config = ConfigDict(extra="forbid")
    document_id: str | None = Field(default=None, max_length=512)
    verdict: Literal["right", "wrong", "unsure", "missed"]
    note: str | None = Field(default=None, max_length=2000)


class AskBody(BaseModel):
    model_config = ConfigDict(extra="forbid")
    prompt: str = Field(min_length=1, max_length=2000)
    period_start: str | None = Field(default=None, pattern=DAY)
    period_end: str | None = Field(default=None, pattern=DAY)


@dataclass
class DashboardContext:
    """Everything a route (or the request engine) may use, all bound to one owner."""

    owner: OwnerConfig
    labels: Any
    evals: Any
    engine: Any
    data: Any = None
    requests: Any = None
    reader: Any = None
    uat: Any = None
    db_port: int = 6657
    errors: dict = field(default_factory=dict)
    ask_runtime: Any = None

    @property
    def owner_id(self) -> str:
        return self.owner.owner_id

    def matching_packets(self, **kwargs) -> list[dict]:
        if self.data is None:
            return []
        return self.data.matching_packets(**kwargs)


def check_bind(host: str) -> str:
    if host != BIND_HOST:
        raise BindRefused("bind_must_be_127.0.0.1")
    return host


def _error(status: int, code: str) -> JSONResponse:
    return JSONResponse({"error": code}, status_code=status)


def _load_ask():
    try:
        return importlib.import_module(ASK_MODULE)
    except ModuleNotFoundError as error:
        if error.name == ASK_MODULE:
            return None
        raise


def _call(function, available: dict):
    """Call the request engine with the arguments its signature asks for."""
    parameters = inspect.signature(function).parameters
    if any(item.kind is inspect.Parameter.VAR_KEYWORD for item in parameters.values()):
        kwargs = dict(available)
    else:
        kwargs = {name: value for name, value in available.items() if name in parameters}
    missing = [
        name
        for name, item in parameters.items()
        if item.default is inspect.Parameter.empty
        and item.kind in (inspect.Parameter.POSITIONAL_OR_KEYWORD, inspect.Parameter.KEYWORD_ONLY)
        and name not in kwargs
    ]
    if missing:
        raise TypeError("request_engine_signature:" + ",".join(missing))
    return function(**kwargs)


def create_app(
    context: DashboardContext,
    *,
    port: int | None = None,
    allowed_hosts: set[str] | None = None,
    static_dir: Path = STATIC_DIR,
    ask_loader=_load_ask,
) -> FastAPI:
    app = FastAPI(title="Manish's Drive check", docs_url=None, redoc_url=None, openapi_url=None)
    hosts = allowed_hosts or {f"{BIND_HOST}:{port}", f"localhost:{port}"}
    origins = {f"http://{host}" for host in hosts}

    @app.middleware("http")
    async def fence(request: Request, call_next):
        if request.headers.get("host", "") not in hosts:
            return _error(421, "host_refused")
        if request.method not in {"GET", "HEAD"}:
            origin = request.headers.get("origin")
            if origin is not None and origin not in origins:
                return _error(403, "origin_refused")
            if not request.headers.get("content-type", "").startswith("application/json"):
                return _error(415, "json_required")
        try:
            response = await call_next(request)
        except Exception:  # noqa: BLE001 - never leak a traceback to the page
            logger.exception("dashboard route failed")
            response = _error(500, "internal_error")
        for name, value in SECURITY_HEADERS.items():
            response.headers.setdefault(name, value)
        return response

    @app.exception_handler(PacketNotFound)
    async def _packet_missing(_request, _error_value):
        return _error(404, "packet_not_found")

    @app.exception_handler(RequestNotFound)
    async def _request_missing(_request, _error_value):
        return _error(404, "request_not_found")

    @app.exception_handler(LabelError)
    async def _label_refused(_request, error_value):
        return _error(422, str(error_value))

    @app.exception_handler(ReadOnlyViolation)
    async def _read_only(_request, error_value):
        logger.error("read-only fence refused a statement: %s", error_value)
        return _error(500, "read_only_violation")

    try:  # a UAT outage is a 503, not a stack trace
        from sqlalchemy.exc import DBAPIError, OperationalError
        from sqlalchemy.exc import TimeoutError as PoolTimeout

        @app.exception_handler(OperationalError)
        async def _db_down(_request, _error_value):
            return _error(503, "uat_unavailable")

        @app.exception_handler(PoolTimeout)
        async def _db_busy(_request, _error_value):
            return _error(503, "uat_connection_busy")

        @app.exception_handler(DBAPIError)
        async def _db_error(_request, _error_value):
            logger.error("UAT read failed: %s", type(_error_value).__name__)
            return _error(503, "uat_read_failed")
    except ImportError:  # pragma: no cover - sqlalchemy is a dependency
        pass

    def need(component, name: str):
        if component is None:
            raise Unavailable(context.errors.get(name) or f"{name}_unavailable")
        return component

    @app.exception_handler(Unavailable)
    async def _unavailable(_request, error_value):
        return _error(503, str(error_value))

    @app.exception_handler(RequestValidationError)
    async def _invalid_request(_request, _error_value):
        return _error(422, "invalid_body")

    # Page -------------------------------------------------------------------------
    if static_dir.is_dir():
        app.mount("/static", StaticFiles(directory=static_dir), name="static")

    @app.get("/", include_in_schema=False)
    def page():
        index = static_dir / "index.html"
        if index.is_file():
            return FileResponse(index, media_type="text/html; charset=utf-8")
        return HTMLResponse(
            "<!doctype html><meta charset=utf-8><title>Manish's Drive check</title>"
            "<p>The dashboard page is not installed; the API is at /api/engine.</p>"
        )

    # Engine, owner, health ------------------------------------------------------------
    @app.get("/api/engine")
    def engine():
        return {
            **context.engine.snapshot(),
            "notices": {"dry_run": DRY_RUN_NOTICE, "real_requests": STRIPE_NOTICE},
        }

    @app.get("/api/owner")
    def owner():
        return need(context.data, "data").owner_summary()

    @app.get("/api/health")
    def health():
        return need(context.data, "data").health()

    # Packets ----------------------------------------------------------------------
    @app.get("/api/packets")
    def packets():
        return need(context.data, "data").packets()

    @app.get("/api/packets/{packet_id}")
    def packet(packet_id: str):
        return need(context.data, "data").packet_detail(packet_id)

    @app.post("/api/packets/{packet_id}/label")
    def label_packet(packet_id: str, body: PacketLabelBody):
        data = need(context.data, "data")
        canonical, version = data.packet_identity(packet_id)
        context.labels.save_packet_label(
            packet_id=canonical,
            version=version,
            verdict=body.verdict,
            reason=body.reason,
            note=body.note,
        )
        return {"saved": True}

    # Real requests ------------------------------------------------------------------
    @app.get("/api/requests")
    def requests_list():
        return need(context.requests, "requests").list()

    @app.get("/api/requests/{request_id}")
    def request_detail(request_id: str):
        return need(context.requests, "requests").detail(request_id)

    @app.post("/api/requests/{request_id}/label")
    def label_request(request_id: str, body: DocumentLabelBody):
        requests = need(context.requests, "requests")
        canonical = requests.canonical(request_id)
        context.labels.save_request_label(
            request_id=canonical, document_id=body.document_id, verdict=body.verdict, note=body.note
        )
        return {"saved": True}

    # Dry-run asks (the request engine lives in dashboard.ask) -------------------------
    def ask_module():
        try:
            module = ask_loader()
        except Exception:  # noqa: BLE001 - a broken engine import is a 503 with a reason
            logger.exception("request engine failed to load")
            raise Unavailable("request engine failed to load") from None
        if module is None:
            raise Unavailable("request engine not installed")
        return module

    def available(extra: dict | None = None) -> dict:
        state_dir = getattr(context.labels, "path", None)
        return {
            "context": context,
            "owner_id": context.owner_id,
            "uat": context.uat,
            "data": context.data,
            "labels": context.labels,
            "matching_packets": context.matching_packets,
            "engine_info": context.engine.snapshot(),
            "state_dir": state_dir,
            "private_dir": state_dir,
            "db_port": context.db_port,
            **(extra or {}),
        }

    async def invoke(function, arguments: dict):
        if inspect.iscoroutinefunction(function):
            return await _call(function, arguments)
        return await run_in_threadpool(_call, function, arguments)

    runtime_lock = asyncio.Lock()

    async def engine_runtime(module, function) -> dict:
        """The engine's runtime, built once, when its entry point asks for one."""
        if "runtime" not in inspect.signature(function).parameters:
            return {}
        builder = getattr(module, "build_live_runtime", None)
        if builder is None:
            raise Unavailable("request engine runtime not available")
        async with runtime_lock:
            if context.ask_runtime is None:
                context.ask_runtime = await invoke(builder, available())
        return {"runtime": context.ask_runtime}

    @app.get("/api/presets")
    async def presets():
        module = ask_module()
        return await invoke(module.presets, available(await engine_runtime(module, module.presets)))

    @app.post("/api/ask")
    async def ask(body: AskBody):
        module = ask_module()
        result = await invoke(
            module.run_ask,
            available(
                {
                    "prompt": body.prompt,
                    "period_start": body.period_start,
                    "period_end": body.period_end,
                    **(await engine_runtime(module, module.run_ask)),
                }
            ),
        )
        ask_id = result.get("ask_id") if isinstance(result, dict) else None
        if isinstance(ask_id, str) and SAFE_ID.fullmatch(ask_id):
            if context.labels.known_ask(ask_id) is None:
                context.labels.save_ask(result)
        return result

    @app.post("/api/ask/{ask_id}/label")
    def label_ask(ask_id: str, body: DocumentLabelBody):
        if not SAFE_ID.fullmatch(ask_id) or context.labels.known_ask(ask_id) is None:
            return _error(404, "ask_not_found")
        context.labels.save_ask_label(
            ask_id=ask_id, document_id=body.document_id, verdict=body.verdict, note=body.note
        )
        return {"saved": True}

    # Accuracy and eval ------------------------------------------------------------------
    @app.get("/api/accuracy")
    def accuracy():
        served_ai = {}
        if context.data is not None:
            served_ai = {
                item["packet_id"]: item.get("ai_verdict") for item in context.data.packets()
            }
        packets_part = packet_accuracy(
            context.evals.ready_packets(), context.labels.packet_labels(), served_ai
        )
        ask_labels = context.labels.ask_labels()
        dry_runs = [
            (record["ask_id"], record.get("documents") or [], ask_labels.get(record["ask_id"], {}))
            for record in context.labels.asks()
        ]
        real = []
        if context.requests is not None:
            request_labels = context.labels.request_labels()
            for item in context.requests.list():
                labels = request_labels.get(item["request_id"], {})
                if labels:
                    documents = context.requests.detail(item["request_id"])["documents"]
                else:
                    documents = [{"selected": True}] * int(item.get("selected_count") or 0)
                real.append((item["request_id"], documents, labels))
        return {"packets": packets_part, "requests": request_accuracy(dry_runs, real)}

    @app.get("/api/eval")
    def eval_view():
        return {
            **context.evals.view(),
            "dashboard_packet_labels": len(context.labels.packet_labels()),
        }

    @app.exception_handler(ValidationError)
    async def _invalid(_request, _error_value):
        return _error(422, "invalid_body")

    return app


def serve(app: FastAPI, *, host: str = BIND_HOST, port: int) -> None:
    """Run the app on 127.0.0.1 only (anything else is refused before binding)."""
    import uvicorn

    check_bind(host)
    if not 1024 <= int(port) <= 65535:
        raise BindRefused("port_out_of_range")
    uvicorn.Server(
        uvicorn.Config(app, host=host, port=int(port), log_level="info", access_log=False)
    ).run()
