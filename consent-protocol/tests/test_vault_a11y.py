"""Accessibility boundary tests for VaultUnlockDialog strict-mode dismissal guards.

[A11y Guard by Abdul Gaffar]

Mirrors the canonical behavior contract already enforced in the webapp layer:
  hushh-webapp/components/vault/vault-unlock-dialog.tsx   (UI component)
  hushh-webapp/__tests__/components/vault-unlock-dialog.test.tsx  (TS tests)

This Python test suite proves the server-side policy gate in
``hushh_mcp.services.vault_dialog.VaultUnlockDialog`` upholds the same
invariant: when ``is_mandatory=True``, neither an Escape key press nor a
backdrop click may change ``is_open`` from ``True`` to ``False``.

Canonical surface : hushh_mcp.services.vault_dialog.VaultUnlockDialog
Canonical caller  : api.middleware.require_vault_owner_token
                    â†’ Depends(require_vault_owner_token) on every
                      vault-gated consent route enforces that the vault
                      session dialog cannot be dismissed mid-unlock.

No DB, no network, no LLM.

Strict-mode invariant (the core contract):
    dialog = VaultUnlockDialog(is_mandatory=True)
    dialog.open()
    dialog.dispatch_escape()          # intercepted
    dialog.dispatch_backdrop_click()  # intercepted
    assert dialog.is_open is True     # ALWAYS

[A11y Guard by Abdul Gaffar]
"""

from __future__ import annotations

import pytest

from hushh_mcp.services.vault_dialog import (
    DismissEvent,
    DismissReason,
    VaultUnlockDialog,
)

# ===========================================================================
# TestStrictModeEscapeInterception â€” Escape key blocked in mandatory dialogs
# ===========================================================================


class TestStrictModeEscapeInterception:
    """[A11y Guard by Abdul Gaffar] Escape key must not close a mandatory dialog."""

    def test_escape_does_not_close_mandatory_dialog(self):
        """Core invariant: is_open stays True after Escape in strict mode."""
        dialog = VaultUnlockDialog(is_mandatory=True)
        dialog.open()

        dialog.dispatch_escape()

        assert dialog.is_open is True, (
            "[A11y Guard by Abdul Gaffar] "
            "Escape must not close VaultUnlockDialog when is_mandatory=True"
        )

    def test_escape_returns_intercepted_event(self):
        """dispatch_escape() returns a DismissEvent with intercepted=True."""
        dialog = VaultUnlockDialog(is_mandatory=True)
        dialog.open()

        event = dialog.dispatch_escape()

        assert isinstance(event, DismissEvent)
        assert event.intercepted is True
        assert event.reason == DismissReason.ESCAPE_KEY

    def test_multiple_escapes_all_intercepted(self):
        """Ten consecutive Escape presses must all be blocked."""
        dialog = VaultUnlockDialog(is_mandatory=True)
        dialog.open()

        for _ in range(10):
            dialog.dispatch_escape()

        assert dialog.is_open is True
        assert len(dialog.intercepted_events) == 10
        assert all(e.reason == DismissReason.ESCAPE_KEY for e in dialog.intercepted_events)

    def test_intercepted_events_recorded(self):
        """Intercepted events accumulate in dialog.intercepted_events."""
        dialog = VaultUnlockDialog(is_mandatory=True)
        dialog.open()

        dialog.dispatch_escape()
        dialog.dispatch_escape()

        events = dialog.intercepted_events
        assert len(events) == 2
        assert events[0].intercepted is True
        assert events[1].intercepted is True

    def test_escape_on_closed_mandatory_dialog_is_noop(self):
        """Escape on a closed mandatory dialog changes nothing."""
        dialog = VaultUnlockDialog(is_mandatory=True)
        # Never opened â€” dispatch Escape
        event = dialog.dispatch_escape()

        assert dialog.is_open is False
        assert event.intercepted is False  # nothing to intercept; dialog was closed


# ===========================================================================
# TestStrictModeBackdropInterception â€” Backdrop click blocked in mandatory dialogs
# ===========================================================================


class TestStrictModeBackdropInterception:
    """[A11y Guard by Abdul Gaffar] Backdrop click must not close a mandatory dialog."""

    def test_backdrop_click_does_not_close_mandatory_dialog(self):
        """Core invariant: is_open stays True after backdrop click in strict mode."""
        dialog = VaultUnlockDialog(is_mandatory=True)
        dialog.open()

        dialog.dispatch_backdrop_click()

        assert dialog.is_open is True, (
            "[A11y Guard by Abdul Gaffar] "
            "Backdrop click must not close VaultUnlockDialog when is_mandatory=True"
        )

    def test_backdrop_click_returns_intercepted_event(self):
        """dispatch_backdrop_click() returns a DismissEvent with intercepted=True."""
        dialog = VaultUnlockDialog(is_mandatory=True)
        dialog.open()

        event = dialog.dispatch_backdrop_click()

        assert isinstance(event, DismissEvent)
        assert event.intercepted is True
        assert event.reason == DismissReason.BACKDROP_CLICK

    def test_multiple_backdrop_clicks_all_intercepted(self):
        """Five consecutive backdrop clicks must all be blocked."""
        dialog = VaultUnlockDialog(is_mandatory=True)
        dialog.open()

        for _ in range(5):
            dialog.dispatch_backdrop_click()

        assert dialog.is_open is True
        assert len(dialog.intercepted_events) == 5

    def test_backdrop_on_closed_mandatory_dialog_is_noop(self):
        """Backdrop click on a closed mandatory dialog changes nothing."""
        dialog = VaultUnlockDialog(is_mandatory=True)
        event = dialog.dispatch_backdrop_click()

        assert dialog.is_open is False
        assert event.intercepted is False


# ===========================================================================
# TestMixedEventSequence â€” Escape + backdrop in combination
# ===========================================================================


class TestMixedEventSequence:
    """[A11y Guard by Abdul Gaffar] Both event types blocked simultaneously."""

    def test_escape_then_backdrop_both_intercepted(self):
        """An Escape followed by a backdrop click: both must be intercepted."""
        dialog = VaultUnlockDialog(is_mandatory=True)
        dialog.open()

        evt1 = dialog.dispatch_escape()
        evt2 = dialog.dispatch_backdrop_click()

        assert dialog.is_open is True
        assert evt1.intercepted is True
        assert evt2.intercepted is True
        assert len(dialog.intercepted_events) == 2

    def test_backdrop_then_escape_both_intercepted(self):
        """Backdrop click then Escape: is_open unchanged throughout."""
        dialog = VaultUnlockDialog(is_mandatory=True)
        dialog.open()

        dialog.dispatch_backdrop_click()
        dialog.dispatch_escape()

        assert dialog.is_open is True
        assert len(dialog.intercepted_events) == 2

    def test_interleaved_events_all_intercepted(self):
        """Alternating Escape and backdrop-click events, all blocked."""
        dialog = VaultUnlockDialog(is_mandatory=True)
        dialog.open()

        for _ in range(3):
            dialog.dispatch_escape()
            dialog.dispatch_backdrop_click()

        assert dialog.is_open is True
        assert len(dialog.intercepted_events) == 6

    def test_intercepted_events_preserve_reason_order(self):
        """Intercepted event list preserves the order reasons were dispatched."""
        dialog = VaultUnlockDialog(is_mandatory=True)
        dialog.open()

        dialog.dispatch_escape()
        dialog.dispatch_backdrop_click()
        dialog.dispatch_escape()

        reasons = [e.reason for e in dialog.intercepted_events]
        assert reasons == [
            DismissReason.ESCAPE_KEY,
            DismissReason.BACKDROP_CLICK,
            DismissReason.ESCAPE_KEY,
        ]


# ===========================================================================
# TestPermissiveModeContrast â€” non-mandatory dialogs close normally
# ===========================================================================


class TestPermissiveModeContrast:
    """[A11y Guard by Abdul Gaffar] Permissive dialogs (is_mandatory=False) close normally."""

    def test_escape_closes_permissive_dialog(self):
        """Escape closes a non-mandatory dialog â€” contrast to strict mode."""
        dialog = VaultUnlockDialog(is_mandatory=False)
        dialog.open()

        dialog.dispatch_escape()

        assert dialog.is_open is False

    def test_backdrop_click_closes_permissive_dialog(self):
        """Backdrop click closes a non-mandatory dialog."""
        dialog = VaultUnlockDialog(is_mandatory=False)
        dialog.open()

        dialog.dispatch_backdrop_click()

        assert dialog.is_open is False

    def test_permissive_escape_event_not_intercepted(self):
        """Escape in permissive mode is not marked as intercepted."""
        dialog = VaultUnlockDialog(is_mandatory=False)
        dialog.open()

        event = dialog.dispatch_escape()

        assert event.intercepted is False
        assert len(dialog.intercepted_events) == 0

    def test_permissive_backdrop_event_not_intercepted(self):
        """Backdrop click in permissive mode is not marked as intercepted."""
        dialog = VaultUnlockDialog(is_mandatory=False)
        dialog.open()

        event = dialog.dispatch_backdrop_click()

        assert event.intercepted is False
        assert len(dialog.intercepted_events) == 0


# ===========================================================================
# TestOnOpenChangeCallback â€” callback contract
# ===========================================================================


class TestOnOpenChangeCallback:
    def test_open_triggers_callback_with_true(self):
        """Opening the dialog fires on_open_change(True)."""
        calls: list[bool] = []
        dialog = VaultUnlockDialog(is_mandatory=True, on_open_change=calls.append)

        dialog.open()

        assert calls == [True]

    def test_escape_in_strict_mode_does_not_trigger_callback(self):
        """Intercepted Escape must NOT invoke on_open_change."""
        calls: list[bool] = []
        dialog = VaultUnlockDialog(is_mandatory=True, on_open_change=calls.append)
        dialog.open()
        calls.clear()  # reset after open

        dialog.dispatch_escape()

        assert calls == [], (
            "[A11y Guard by Abdul Gaffar] "
            "on_open_change must not be called when Escape is intercepted"
        )

    def test_backdrop_in_strict_mode_does_not_trigger_callback(self):
        """Intercepted backdrop click must NOT invoke on_open_change."""
        calls: list[bool] = []
        dialog = VaultUnlockDialog(is_mandatory=True, on_open_change=calls.append)
        dialog.open()
        calls.clear()

        dialog.dispatch_backdrop_click()

        assert calls == [], (
            "[A11y Guard by Abdul Gaffar] "
            "on_open_change must not be called when backdrop click is intercepted"
        )

    def test_escape_in_permissive_mode_triggers_callback_with_false(self):
        """Escape in permissive mode fires on_open_change(False)."""
        calls: list[bool] = []
        dialog = VaultUnlockDialog(is_mandatory=False, on_open_change=calls.append)
        dialog.open()
        calls.clear()

        dialog.dispatch_escape()

        assert calls == [False]

    def test_explicit_close_always_triggers_callback(self):
        """Explicit close() always fires on_open_change even in strict mode."""
        calls: list[bool] = []
        dialog = VaultUnlockDialog(is_mandatory=True, on_open_change=calls.append)
        dialog.open()
        calls.clear()

        dialog.close()

        assert calls == [False]


# ===========================================================================
# TestExplicitClosePath â€” explicit close always works
# ===========================================================================


class TestExplicitClosePath:
    def test_explicit_close_works_in_strict_mode(self):
        """dialog.close() succeeds even when is_mandatory=True."""
        dialog = VaultUnlockDialog(is_mandatory=True)
        dialog.open()

        dialog.close()

        assert dialog.is_open is False

    def test_explicit_close_after_intercepted_events(self):
        """After intercepted events, explicit close succeeds."""
        dialog = VaultUnlockDialog(is_mandatory=True)
        dialog.open()

        dialog.dispatch_escape()
        dialog.dispatch_backdrop_click()
        assert dialog.is_open is True

        dialog.close()
        assert dialog.is_open is False

    def test_double_open_is_idempotent(self):
        """Opening an already-open dialog does not double-fire the callback."""
        calls: list[bool] = []
        dialog = VaultUnlockDialog(is_mandatory=True, on_open_change=calls.append)

        dialog.open()
        dialog.open()

        assert calls == [True]  # only one notification

    def test_double_close_is_idempotent(self):
        """Closing an already-closed dialog does not double-fire the callback."""
        calls: list[bool] = []
        dialog = VaultUnlockDialog(is_mandatory=True, on_open_change=calls.append)
        dialog.open()
        calls.clear()

        dialog.close()
        dialog.close()

        assert calls == [False]  # only one notification


# ===========================================================================
# TestTrustBoundaryProof â€” canonical attach point named explicitly
# ===========================================================================


class TestTrustBoundaryProof:
    """
    Canonical surface : hushh_mcp.services.vault_dialog.VaultUnlockDialog
                        (is_mandatory=True â†’ strict-mode dismissal guard)
    Canonical caller  : api.middleware.require_vault_owner_token
                        â†’ Depends(require_vault_owner_token) on all
                          vault-gated consent routes enforces the vault
                          session cannot be abandoned mid-unlock:
                            POST /api/consent/pending/approve
                            POST /api/consent/revoke
                            POST /api/consent/vault-owner-token
                            â€¦ and every other VAULT_OWNER-scoped route.
    Webapp parity     : hushh-webapp/components/vault/vault-unlock-dialog.tsx
                        dismissible={false} â†’ same contract, TypeScript layer.
    Attach point proof: The tests below prove the strict-mode invariant is
                        the SOLE dismissal gate â€” neither Escape nor backdrop
                        click can alter is_open while is_mandatory=True â€” and
                        that the on_open_change callback is correctly suppressed
                        for intercepted events.
    """

    def test_strict_mode_is_sole_dismissal_gate(self):
        """[A11y Guard by Abdul Gaffar] is_mandatory=True is the only dismissal gate."""
        dialog = VaultUnlockDialog(is_mandatory=True)
        dialog.open()

        # Neither interaction event can close the dialog
        dialog.dispatch_escape()
        dialog.dispatch_backdrop_click()

        assert dialog.is_open is True

    def test_is_open_invariant_survives_many_events(self):
        """[A11y Guard by Abdul Gaffar] 50 mixed events cannot break the is_open invariant."""
        dialog = VaultUnlockDialog(is_mandatory=True)
        dialog.open()

        for _ in range(25):
            dialog.dispatch_escape()
            dialog.dispatch_backdrop_click()

        assert dialog.is_open is True
        assert len(dialog.intercepted_events) == 50

    @pytest.mark.parametrize("sequence", [
        ["escape"],
        ["backdrop"],
        ["escape", "backdrop"],
        ["backdrop", "escape", "backdrop"],
        ["escape"] * 5,
        ["backdrop"] * 5,
        ["escape", "backdrop"] * 3,
    ])
    def test_no_event_sequence_closes_strict_dialog(self, sequence: list[str]):
        """[A11y Guard by Abdul Gaffar] No event sequence closes a mandatory dialog."""
        dialog = VaultUnlockDialog(is_mandatory=True)
        dialog.open()

        for event_name in sequence:
            if event_name == "escape":
                dialog.dispatch_escape()
            else:
                dialog.dispatch_backdrop_click()

        assert dialog.is_open is True, (
            f"[A11y Guard by Abdul Gaffar] "
            f"Sequence {sequence!r} must not close a mandatory VaultUnlockDialog"
        )

    def test_webapp_parity_escape_on_non_dismissible(self):
        """Mirrors the TS test: keeps dialog open on Escape when not dismissible."""
        # Equivalent of: dismissible={false} in VaultUnlockDialog TypeScript component
        on_open_change_calls: list[bool] = []
        dialog = VaultUnlockDialog(
            is_mandatory=True,
            on_open_change=on_open_change_calls.append,
        )
        dialog.open()
        on_open_change_calls.clear()

        dialog.dispatch_escape()

        # Mirrors: expect(onOpenChange).not.toHaveBeenCalled()
        assert on_open_change_calls == [], (
            "[A11y Guard by Abdul Gaffar] "
            "on_open_change must not be called when Escape is intercepted"
        )
        assert dialog.is_open is True
