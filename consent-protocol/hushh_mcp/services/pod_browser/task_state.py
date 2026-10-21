"""Memory-only state shared by the Browser control and lifecycle owners."""

from __future__ import annotations

import asyncio
from dataclasses import dataclass, field

from hushh_mcp.services.pod_upgrade_admission import TurnPermit

from .contracts import BrowserBinding
from .control import BrowserControl
from .information import BrowserModelProcessing
from .sessions import BrowserSessions
from .task_authority import TaskAuthority, TaskConsent
from .task_contracts import (
    BrowserOwnerAccess,
    BrowserReviewOffer,
    BrowserTaskRequest,
    BrowserTaskSnapshot,
    Phase,
)


@dataclass
class BrowserTaskState:
    binding: BrowserBinding
    request: BrowserTaskRequest | None = field(repr=False)
    access: BrowserOwnerAccess | None = field(repr=False)
    permit: TurnPermit = field(repr=False)
    request_id: str
    request_commitment: str = field(repr=False)
    terminal: BrowserTaskSnapshot | None = field(default=None, repr=False)
    close_payload: dict | None = field(default=None, repr=False)
    consent: TaskConsent | None = field(default=None, repr=False)
    authority: TaskAuthority | None = field(default=None, repr=False)
    control: BrowserControl | None = field(default=None, repr=False)
    processing: BrowserModelProcessing | None = field(default=None, repr=False)
    sessions: BrowserSessions | None = field(default=None, repr=False)
    worker: asyncio.Task | None = field(default=None, repr=False)
    monitor: asyncio.Task | None = field(default=None, repr=False)
    closing: asyncio.Task | None = field(default=None, repr=False)
    starting: asyncio.Task | None = field(default=None, repr=False)
    input_worker: asyncio.Task | None = field(default=None, repr=False)
    save_worker: asyncio.Task | None = field(default=None, repr=False)
    input_commitment: str | None = field(default=None, repr=False)
    delivery_id: str | None = None
    delivery_attached: asyncio.Event = field(default_factory=asyncio.Event, repr=False)
    publication_finished: asyncio.Event = field(default_factory=asyncio.Event, repr=False)
    finished: asyncio.Event = field(default_factory=asyncio.Event, repr=False)
    phase: Phase = "running"
    revision: int = 1
    code: str | None = None
    summary: str | None = field(default=None, repr=False)
    review: BrowserReviewOffer | None = field(default=None, repr=False)
    closed: bool = False
    processing_approved: bool = False
    stop_refusal: str | None = None
    model_completed: bool = False
    saved_downloads: dict[str, dict] = field(default_factory=dict, repr=False)
    operation: asyncio.Lock = field(default_factory=asyncio.Lock, repr=False)
    review_operation: asyncio.Lock = field(default_factory=asyncio.Lock, repr=False)
    review_ready: asyncio.Event = field(default_factory=asyncio.Event, repr=False)
    review_waiting: str | None = None

    def detach_terminal(self, snapshot: BrowserTaskSnapshot) -> None:
        """Joined browser is gone; retain no bearer closure, goal or private port."""
        self.terminal, self.revision, self.summary = snapshot, snapshot.revision, snapshot.summary
        self.request = self.access = self.processing = self.consent = None
        self.sessions = self.authority = self.control = None
        self.worker = self.monitor = self.input_worker = self.starting = self.save_worker = None
        self.input_commitment = None
