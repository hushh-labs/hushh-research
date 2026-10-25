"""Deterministic Chromium inputs; consent and execution scope stay with the caller."""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from typing import TYPE_CHECKING, TypeVar

from .contracts import BrowserAction, BrowserRefused

if TYPE_CHECKING:
    from playwright.async_api import Page
T = TypeVar("T")


def _argument(value: T | None) -> T:
    if value is None:
        raise BrowserRefused("BROWSER_ACTION_INVALID")
    return value


async def perform_action(
    page: Page,
    action: BrowserAction,
    timeout_ms: float,
    navigate: Callable[[Page, BrowserAction, float], Awaitable[None]],
) -> None:
    match action.operation:
        case "navigate":
            await navigate(page, action, timeout_ms)
        case "click":
            await page.mouse.click(_argument(action.x), _argument(action.y))
        case "hover":
            await page.mouse.move(_argument(action.x), _argument(action.y))
        case "type":
            if not action.focus_existing:
                await page.mouse.click(_argument(action.x), _argument(action.y))
            if action.clear_before_typing:
                await page.keyboard.press("ControlOrMeta+A")
                await page.keyboard.press("Backspace")
            await page.keyboard.insert_text(_argument(action.text))
            if action.press_enter:
                await page.keyboard.press("Enter")
        case "scroll":
            if action.magnitude is None or action.direction is None:
                raise BrowserRefused("BROWSER_ACTION_INVALID")
            if action.x is not None:
                await page.mouse.move(action.x, _argument(action.y))
            x, y = {
                "up": (0, -action.magnitude),
                "down": (0, action.magnitude),
                "left": (-action.magnitude, 0),
                "right": (action.magnitude, 0),
            }[action.direction]
            await page.mouse.wheel(x, y)
        case "back":
            await page.go_back(wait_until="domcontentloaded", timeout=timeout_ms)
        case "forward":
            await page.go_forward(wait_until="domcontentloaded", timeout=timeout_ms)
        case "keys":
            await page.keyboard.press("+".join(action.keys))
        case "drag":
            await page.mouse.move(_argument(action.x), _argument(action.y))
            await page.mouse.down()
            try:
                await page.mouse.move(
                    _argument(action.destination_x),
                    _argument(action.destination_y),
                    steps=5,
                )
            finally:
                await page.mouse.up()
        case "observe":
            pass
        case "resize":
            await page.set_viewport_size(
                {"width": _argument(action.width), "height": _argument(action.height)}
            )
