"""Pixel-exact Azure native actions through the existing Browser control port."""

from __future__ import annotations

import asyncio
import base64

from google.adk.tools import FunctionTool

from hushh_mcp.runtime_providers.azure_browser_adk import ComputerCall, ComputerResult

from .contracts import BrowserAction, BrowserFrame, BrowserRefused
from .control import BrowserControl
from .geometry import viewport_for_action
from .information import BrowserModelProcessing
from .origin import public_origin
from .provider_review import review_provider_action

_KEYS = {
    "ENTER": "Enter",
    "RETURN": "Enter",
    "TAB": "Tab",
    "ESC": "Escape",
    "ESCAPE": "Escape",
    "BACKSPACE": "Backspace",
    "DELETE": "Delete",
    "CTRL": "Control",
    "CONTROL": "Control",
    "ALT": "Alt",
    "SHIFT": "Shift",
    "META": "Meta",
    "CMD": "Meta",
    "ARROWUP": "ArrowUp",
    "ARROWDOWN": "ArrowDown",
    "ARROWLEFT": "ArrowLeft",
    "ARROWRIGHT": "ArrowRight",
    "SPACE": "Space",
    "HOME": "Home",
    "END": "End",
    "PAGEUP": "PageUp",
    "PAGEDOWN": "PageDown",
}


def native_actions(call: ComputerCall, control: BrowserControl) -> list[BrowserAction]:
    """Validate the complete batch before any action can be delivered.

    Unsupported mouse buttons, held modifiers and multi-segment drags refuse
    explicitly. No approximate coordinates or partial batch execution.
    """
    actions: list[BrowserAction] = []
    for source in call.actions:
        values = dict(source)
        kind = values.pop("type", None)
        if kind not in {
            "screenshot",
            "wait",
            "move",
            "keypress",
            "click",
            "type",
            "scroll",
            "drag",
        }:
            raise BrowserRefused("BROWSER_NATIVE_ACTION_UNSUPPORTED")
        keys = values.pop("keys", None) if kind != "keypress" else None
        if keys:
            raise BrowserRefused("BROWSER_NATIVE_ACTION_UNSUPPORTED")
        operation = {
            "screenshot": "observe",
            "wait": "observe",
            "move": "hover",
            "keypress": "keys",
        }.get(kind, kind)
        if kind == "click" and values.pop("button", None) != "left":
            raise BrowserRefused("BROWSER_NATIVE_ACTION_UNSUPPORTED")
        if kind == "type":
            values.update(focus_existing=True, clear_before_typing=False)
        if kind == "keypress":
            requested = values.get("keys")
            if not isinstance(requested, list) or not 1 <= len(requested) <= 4:
                raise BrowserRefused("BROWSER_NATIVE_ACTION_UNSUPPORTED")
            mapped = []
            for key in requested:
                if not isinstance(key, str):
                    raise BrowserRefused("BROWSER_NATIVE_ACTION_UNSUPPORTED")
                mapped.append(
                    _KEYS.get(key.upper(), key if len(key) == 1 and key.isascii() else "")
                )
            values["keys"] = tuple(mapped)
        if kind == "scroll":
            dx, dy = values.pop("scroll_x", None), values.pop("scroll_y", None)
            if type(dx) is not int or type(dy) is not int or (dx != 0 and dy != 0):
                raise BrowserRefused("BROWSER_NATIVE_ACTION_UNSUPPORTED")
            values.update(
                direction=("right" if dx > 0 else "left") if dx else ("down" if dy > 0 else "up"),
                magnitude=abs(dx or dy),
            )
        if kind == "drag":
            path = values.pop("path", None)
            if (
                not isinstance(path, list)
                or len(path) != 2
                or any(not isinstance(p, dict) or set(p) != {"x", "y"} for p in path)
            ):
                raise BrowserRefused("BROWSER_NATIVE_ACTION_UNSUPPORTED")
            values.update(
                x=path[0]["x"],
                y=path[0]["y"],
                destination_x=path[1]["x"],
                destination_y=path[1]["y"],
            )
        try:
            action = BrowserAction(
                operation=operation,
                sequence=control.next_sequence + len(actions),
                control_epoch=control.control_epoch,
                **values,
            )
            viewport_for_action(control.viewport, action)
        except (ValueError, TypeError):
            raise BrowserRefused("BROWSER_NATIVE_ACTION_UNSUPPORTED") from None
        actions.append(action)
    return actions


class AzureComputerTools:
    def __init__(self, control: BrowserControl, processing: BrowserModelProcessing) -> None:
        self._control, self._processing = control, processing
        self._seen: set[str] = set()

        async def browser_native_call(call: dict) -> dict:
            return await self.execute(call)

        async def navigate(url: str) -> dict:
            """Navigate to a task-approved public website in the headless browser."""
            epoch = await control.require_model_observation()
            await processing.require()
            if public_origin(url) not in processing.allowed_origins:
                raise BrowserRefused("BROWSER_DESTINATION_REFUSED")
            await control.require_model_observation(expected_epoch=epoch)
            await control.execute(
                BrowserAction(
                    operation="navigate",
                    url=url,
                    sequence=control.next_sequence,
                    control_epoch=epoch,
                )
            )
            await control.require_model_observation(expected_epoch=epoch)
            return {"status": "navigated"}

        self.tools = [FunctionTool(browser_native_call), FunctionTool(navigate)]

    async def _frame(self, frame: BrowserFrame, epoch: int) -> None:
        await self._control.require_model_observation(expected_epoch=epoch)
        await self._processing.require()
        await self._control.require_model_observation(expected_epoch=epoch)
        if (
            frame.url != "about:blank"
            and public_origin(frame.url) not in self._processing.allowed_origins
        ):
            raise BrowserRefused("BROWSER_SCREEN_PROCESSING_REFUSED")

    async def execute(self, source: dict) -> dict:
        try:
            call = ComputerCall.from_provider(source)
        except ValueError:
            raise BrowserRefused("BROWSER_NATIVE_CALL_INVALID") from None
        control = self._control
        if call.call_id in self._seen or len(self._seen) >= 60:
            raise BrowserRefused("BROWSER_ACTION_REPLAY")
        epoch = await control.require_model_observation()
        await self._processing.require()
        await control.require_model_observation(expected_epoch=epoch)
        await control.initialize()
        actions = native_actions(call, control)
        if call.pending_safety_checks:
            await review_provider_action(
                control,
                self._processing,
                call_id=call.call_id,
                tool="browser_native_call",
                arguments={"call": call.model_dump(exclude_none=True)},
                warnings=[
                    check.model_dump(exclude_none=True) for check in call.pending_safety_checks
                ],
            )
        self._seen.add(call.call_id)
        frame = None
        for source_action, action in zip(call.actions, actions, strict=True):
            if source_action["type"] == "wait":
                await asyncio.sleep(2)  # bounded provider wait; no keepalive
            await control.require_model_observation(expected_epoch=epoch)
            frame = await control.execute(action, native_focus=action.focus_existing)
            await self._frame(frame, epoch)
        if frame is None:
            raise BrowserRefused("BROWSER_NATIVE_CALL_INVALID")
        return dict(
            ComputerResult(
                call_id=call.call_id,
                png_base64=base64.b64encode(frame.png).decode("ascii"),
                acknowledged_safety_checks=call.pending_safety_checks,
            ).model_dump(mode="json")
        )
