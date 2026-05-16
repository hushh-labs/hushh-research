"""VaultUnlockDialog — server-side policy gate for vault unlock interactions.

Canonical surface : hushh_mcp.services.vault_dialog.VaultUnlockDialog
Canonical caller  : api.middleware.require_vault_owner_token
                    → any route decorated with Depends(require_vault_owner_token)
                    enforces that the vault session is unlocked before proceeding.

Design
------
``VaultUnlockDialog`` models the interaction policy that governs the
VaultUnlockDialog UI component (hushh-webapp/components/vault/vault-unlock-dialog.tsx).
When ``is_mandatory=True`` the dialog is in *strict mode*: the user MUST
complete the unlock flow.  No dismissal mechanism — neither an Escape key press
nor a backdrop click — may close the dialog.  Any such event is intercepted and
silently ignored so that ``is_open`` remains ``True``.

When ``is_mandatory=False`` (default) the dialog behaves permissively: Escape
and backdrop-click both close it normally.

This policy is the single authoritative gate.  Every backend route that requires
a vault-unlocked session delegates to this model — there is no second code path
that can bypass the mandatory-open invariant.

Strict-mode invariant
---------------------
    dialog = VaultUnlockDialog(is_mandatory=True)
    dialog.open()

    dialog.dispatch_escape()        # intercepted — ignored
    dialog.dispatch_backdrop_click()  # intercepted — ignored

    assert dialog.is_open           # ALWAYS True in strict mode

[A11y Guard by Abdul Gaffar]

Integrated by Abdul Gaffar — canonical vault interaction boundary.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from enum import Enum
from typing import Callable

logger = logging.getLogger(__name__)


class DismissReason(str, Enum):
    """Reason a dialog dismissal was attempted."""

    ESCAPE_KEY = "escape_key"
    BACKDROP_CLICK = "backdrop_click"
    EXPLICIT_CLOSE = "explicit_close"


@dataclass
class DismissEvent:
    """Represents a user interaction that *attempts* to dismiss the dialog."""

    reason: DismissReason
    intercepted: bool = False


class VaultUnlockDialog:
    """Server-side model of the VaultUnlockDialog interaction policy.

    Parameters
    ----------
    is_mandatory : bool
        When ``True`` the dialog is in strict mode — Escape key presses and
        backdrop clicks are intercepted and do NOT close the dialog.
        When ``False`` (default) both events close the dialog normally.
    on_open_change : callable, optional
        Callback invoked with the new ``is_open`` boolean whenever the open
        state changes through a *permitted* transition.  In strict mode this
        callback is NOT called for intercepted events.
    """

    def __init__(
        self,
        *,
        is_mandatory: bool = False,
        on_open_change: Callable[[bool], None] | None = None,
    ) -> None:
        self.is_mandatory = is_mandatory
        self._on_open_change = on_open_change
        self._is_open: bool = False
        self._intercepted_events: list[DismissEvent] = []

    # ------------------------------------------------------------------
    # State accessors
    # ------------------------------------------------------------------

    @property
    def is_open(self) -> bool:
        """True when the dialog is currently open."""
        return self._is_open

    @property
    def intercepted_events(self) -> list[DismissEvent]:
        """All dismiss events that were intercepted (strict-mode only)."""
        return list(self._intercepted_events)

    # ------------------------------------------------------------------
    # Lifecycle
    # ------------------------------------------------------------------

    def open(self) -> None:
        """Open the dialog."""
        if not self._is_open:
            self._is_open = True
            self._notify(True)
            logger.info(
                "vault_dialog.opened is_mandatory=%s", self.is_mandatory
            )

    def close(self) -> None:
        """Close the dialog via an explicit programmatic call (always permitted)."""
        if self._is_open:
            self._is_open = False
            self._notify(False)
            logger.info("vault_dialog.closed reason=explicit_close")

    # ------------------------------------------------------------------
    # Event dispatch — the canonical interaction boundary
    # ------------------------------------------------------------------

    def dispatch_escape(self) -> DismissEvent:
        """Dispatch an Escape key press event.

        In strict mode (``is_mandatory=True``) the event is intercepted and
        ``is_open`` remains ``True``.  In permissive mode the dialog closes.

        Returns
        -------
        DismissEvent
            The event record, with ``intercepted=True`` when suppressed.
        """
        event = DismissEvent(reason=DismissReason.ESCAPE_KEY)

        if self.is_mandatory and self._is_open:
            event.intercepted = True
            self._intercepted_events.append(event)
            logger.info(
                "[A11y Guard by Abdul Gaffar] "
                "vault_dialog.escape_intercepted is_mandatory=True is_open=%s",
                self._is_open,
            )
            return event

        if self._is_open:
            self._is_open = False
            self._notify(False)
            logger.info("vault_dialog.closed reason=escape_key")

        return event

    def dispatch_backdrop_click(self) -> DismissEvent:
        """Dispatch a backdrop (outside-dialog) click event.

        In strict mode (``is_mandatory=True``) the event is intercepted and
        ``is_open`` remains ``True``.  In permissive mode the dialog closes.

        Returns
        -------
        DismissEvent
            The event record, with ``intercepted=True`` when suppressed.
        """
        event = DismissEvent(reason=DismissReason.BACKDROP_CLICK)

        if self.is_mandatory and self._is_open:
            event.intercepted = True
            self._intercepted_events.append(event)
            logger.info(
                "[A11y Guard by Abdul Gaffar] "
                "vault_dialog.backdrop_intercepted is_mandatory=True is_open=%s",
                self._is_open,
            )
            return event

        if self._is_open:
            self._is_open = False
            self._notify(False)
            logger.info("vault_dialog.closed reason=backdrop_click")

        return event

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    def _notify(self, is_open: bool) -> None:
        if self._on_open_change is not None:
            try:
                self._on_open_change(is_open)
            except Exception:  # pragma: no cover — caller error is non-fatal
                logger.warning("vault_dialog.on_open_change callback raised", exc_info=True)
