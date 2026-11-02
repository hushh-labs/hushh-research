"""Local semantic tool selection for the Email graph, never mailbox indexing.

Only authored route examples enter the in-memory index. The current request is
embedded locally by FastEmbed; neither it nor mailbox contents are retained.
Tool selection grants no provider, memory, delivery or mutation authority.
"""

from __future__ import annotations

import asyncio
import hashlib
import math
import os
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING, Literal

if TYPE_CHECKING:
    from semantic_router.encoders import DenseEncoder
    from semantic_router.index import BaseIndex
    from semantic_router.routers import IndexedRouter

ALWAYS_AVAILABLE_TOOLS = (
    "read_memory_md",
    "save_to_memory_md",
    "get_connection_status",
)
_RETRIEVAL_TOOLS = ("search_threads", "get_thread", "get_message", "get_attachment")
ROUTE_TOOLS: dict[str, tuple[str, ...]] = {
    # Retrieval closure keeps search -> thread -> attachment within the same
    # graph run. Finding an invoice must not strand its PDF behind another turn.
    "1_gmail_search_query": _RETRIEVAL_TOOLS,
    "2_gmail_read_thread": _RETRIEVAL_TOOLS,
    "3_gmail_attachment_ops": _RETRIEVAL_TOOLS,
    "4_gmail_draft_safe": (*_RETRIEVAL_TOOLS, "create_draft"),
    "5_gmail_send_mutate": (*_RETRIEVAL_TOOLS, "send_email", "reply_to_thread"),
    "6_gmail_triage_organize": (*_RETRIEVAL_TOOLS, "batch_modify_messages", "trash_message"),
}
EMAIL_TOOL_NAMES = tuple(dict.fromkeys(name for names in ROUTE_TOOLS.values() for name in names))

_EXAMPLES: dict[str, tuple[str, ...]] = {
    "1_gmail_search_query": (
        "Find emails from my accountant about invoices last month",
        "Search Gmail for unread messages from the school",
        "Which emails mention the upcoming trip?",
        "Find all PDF invoices in my mailbox",
        "Locate the email containing the contract and read it",
    ),
    "2_gmail_read_thread": (
        "Read the latest email from my accountant",
        "Show the full conversation in this email thread",
        "Summarize the messages and replies in this thread",
        "Open that message and tell me what it says",
        "Read the invoice email and its PDF attachment",
    ),
    "3_gmail_attachment_ops": (
        "Open the PDF attachment on that email",
        "Download the invoice attached to the message",
        "Find PDF invoices in my mailbox and read their attachments",
        "Show the attachments on this email thread",
        "Read the attached contract document",
    ),
    "4_gmail_draft_safe": (
        "Draft an email to my accountant asking about the invoice",
        "Write a reply draft without sending it",
        "Save a draft of my follow up email",
        "Prepare an email for me to review",
        "Find the invoice email and draft a response",
    ),
    "5_gmail_send_mutate": (
        "Send this email to my accountant",
        "Reply to this thread with the approved message",
        "Send my reviewed reply now",
        "Email the final message to the recipient",
        "Find the invoice email and reply to the sender",
    ),
    "6_gmail_triage_organize": (
        "Archive all the newsletters in my inbox",
        "Mark those email messages as read",
        "Apply a label to my invoice emails",
        "Move the spam messages to trash",
        "Find the newsletters and organize them with a label",
    ),
}

# An uncalibrated cosine threshold, not a probability or authority decision.
CONFIDENCE_THRESHOLD = 0.80
MAX_PROMPT_CHARS = 8192
MODEL_NAME = "BAAI/bge-small-en-v1.5"
MODEL_REPOSITORY = "Qdrant/bge-small-en-v1.5-onnx-Q"
MODEL_REVISION = "aa8f8b060edb00e03bfdd08813a2949946c8ba55"
BAKED_MODEL_CACHE = "/opt/hushh/models/email-router-fastembed"
BAKED_MODEL_CACHE_ENV = "HUSHH_EMAIL_ROUTER_MODEL_CACHE"
MODEL_CACHE_REPOSITORY = "models--Qdrant--bge-small-en-v1.5-onnx-Q"
# SHA-256 of the exact pinned snapshot, not a mutable HF branch or download URL.
MODEL_FILES = {
    "config.json": "13582bcf2effc85b7bf3d3f5532e686bc1c9ce86bb009d10f0ec33cbe92299dd",
    "model_optimized.onnx": "51f1bd0addd6e859e42c2c8021a5e5461385bb676a649f4b269aa445449f2431",
    "special_tokens_map.json": "5d5b662e421ea9fac075174bb0688ee0d9431699900b90662acd44b2a350503a",  # gitleaks:allow -- public pinned model SHA-256, not a credential
    "tokenizer.json": "d241a60d5e8f04cc1b2b3e9ef7a4921b27bf526d9f6050ab90f9267a1f9e5c66",  # gitleaks:allow -- public pinned model SHA-256, not a credential
    "tokenizer_config.json": "0b29c7bfc889e53b36d9dd3e686dd4300f6525110eaa98c76a5dafceb2029f53",  # gitleaks:allow -- public pinned model SHA-256, not a credential
}
_router: IndexedRouter | None = None
_router_lock = threading.Lock()


@dataclass(frozen=True)
class RoutingSelection:
    route_ids: tuple[str, ...]
    tool_names: tuple[str, ...]
    confidence: float | None
    elapsed_ms: float
    fallback_reason: Literal["low_confidence", "input_bounds"] | None = None
    confidence_kind: str = "uncalibrated_cosine_similarity"


def verify_email_router_model_cache(cache: Path) -> None:
    """Verify the immutable image artifact before official FastEmbed initialization.

    FastEmbedEncoder 1.1.1 exposes cache_dir, but not model revision or
    local_files_only. Its upstream client 0.9.1 honors HF_HUB_OFFLINE for both
    HF and URL downloads. The build freezes the cache's default reference to
    this exact snapshot; a missing/drifted image never authorizes a download.
    """
    repository = cache / MODEL_CACHE_REPOSITORY
    try:
        if (repository / "refs" / "main").read_text().strip() != MODEL_REVISION:
            raise RuntimeError("Email router model revision mismatch")
        snapshot = repository / "snapshots" / MODEL_REVISION
        for relative, expected in MODEL_FILES.items():
            digest = hashlib.sha256()
            with (snapshot / relative).open("rb") as asset:
                while chunk := asset.read(1024 * 1024):
                    digest.update(chunk)
            if digest.hexdigest() != expected:
                raise RuntimeError("Email router model checksum mismatch")
    except OSError:
        raise RuntimeError("Baked Email router model is unavailable") from None


def _offline_encoder():
    from semantic_router.encoders import FastEmbedEncoder

    if os.getenv("HF_HUB_OFFLINE", "").strip().upper() not in {"1", "TRUE", "YES", "ON"}:
        raise RuntimeError("Email router requires offline model loading")
    cache = Path(os.getenv(BAKED_MODEL_CACHE_ENV) or BAKED_MODEL_CACHE)
    verify_email_router_model_cache(cache)
    return FastEmbedEncoder(name=MODEL_NAME, cache_dir=str(cache), max_length=512, threads=1)


def create_email_router(
    *, encoder: DenseEncoder | None = None, index: BaseIndex | None = None
) -> IndexedRouter:
    """Build the actual IndexedRouter; callers offload this synchronous build.

    Encoder/index injection is for isolated tests of the real library. Production
    always uses its local FastEmbedEncoder and a process-memory LocalIndex.
    """
    from semantic_router import Route
    from semantic_router.index import LocalIndex
    from semantic_router.routers import IndexedRouter

    return IndexedRouter(
        encoder=encoder if encoder is not None else _offline_encoder(),
        index=index if index is not None else LocalIndex(),
        routes=[Route(name=name, utterances=list(_EXAMPLES[name])) for name in ROUTE_TOOLS],
        # Include every example so a frequently matched route cannot crowd a
        # second intent out of the index's nearest-neighbour result window.
        top_k=sum(len(examples) for examples in _EXAMPLES.values()),
        aggregation="max",
        confidence_threshold=CONFIDENCE_THRESHOLD,
    )


def _get_router() -> IndexedRouter:
    global _router
    with _router_lock:
        if _router is None:
            _router = create_email_router()
        return _router


async def warm_email_router() -> None:
    """Load the same singleton/index once per serving worker, without private input."""
    await asyncio.to_thread(_get_router)


def _selection(
    route_ids: tuple[str, ...],
    confidence: float | None,
    started: float,
    fallback_reason: Literal["low_confidence", "input_bounds"] | None = None,
) -> RoutingSelection:
    groups = [ROUTE_TOOLS[route] for route in route_ids] if route_ids else [EMAIL_TOOL_NAMES]
    tools = tuple(
        dict.fromkeys((*ALWAYS_AVAILABLE_TOOLS, *(tool for group in groups for tool in group)))
    )
    return RoutingSelection(
        route_ids,
        tools,
        confidence,
        round((time.perf_counter() - started) * 1000, 2),
        fallback_reason,
    )


async def select_email_tools(prompt: str) -> RoutingSelection:
    """Select all semantically matched groups before Email model tool binding.

    FastEmbed's real async API offloads synchronous inference to a worker thread.
    Construction/model loading is separately offloaded and process-singleton.
    Uncertain selection exposes only the bounded Email tool roster. Router
    failure stops the turn; it never silently removes the requested router.
    No prompt, exception body, mailbox information or credential is logged.
    """
    started = time.perf_counter()
    if not isinstance(prompt, str) or not prompt.strip() or len(prompt) > MAX_PROMPT_CHARS:
        return _selection((), None, started, "input_bounds")
    try:
        router = await asyncio.to_thread(_get_router)
        choices = await router.acall(prompt, limit=None)
        # IndexedRouter returns all above-threshold routes for limit=None.
        accepted = {
            choice.name: float(choice.confidence)
            for choice in choices
            if choice.name in ROUTE_TOOLS
            and choice.confidence is not None
            and math.isfinite(choice.confidence)
        }
    except Exception:
        raise RuntimeError("Email tool selection is unavailable") from None
    if not accepted:
        return _selection((), None, started, "low_confidence")
    routes = tuple(name for name in ROUTE_TOOLS if name in accepted)
    return _selection(routes, max(accepted.values()), started)
