"""Pinned ADK BaseComputer adapter over an owner-authorized execution port."""

from __future__ import annotations

import asyncio
from typing import Literal

from google.adk.tools.computer_use.base_computer import (
    BaseComputer,
    ComputerEnvironment,
    ComputerState,
)

from .contracts import BrowserAction, BrowserRefused, Operation
from .control import BrowserControl


class PodComputer(BaseComputer):
    def __init__(self, control: BrowserControl, *, width: int = 1280, height: int = 720) -> None:
        if (width, height) != (1280, 720):
            raise BrowserRefused("BROWSER_VIEWPORT_UNSUPPORTED")
        self._control = control
        self._size = (width, height)

    async def initialize(self) -> None:
        # ADK initializes BEFORE prepare(tool_context). No authority may be
        # acquired from model-visible ToolContext or session state here.
        await self._control.initialize()

    async def screen_size(self) -> tuple[int, int]:
        await self._control.initialize()
        return self._size

    async def environment(self) -> ComputerEnvironment:
        return ComputerEnvironment.ENVIRONMENT_BROWSER

    async def _act(self, operation: Operation, **values) -> ComputerState:
        try:
            action = BrowserAction(
                operation=operation,
                sequence=self._control.next_sequence,
                control_epoch=self._control.control_epoch,
                **values,
            )
        except ValueError:
            raise BrowserRefused("BROWSER_ACTION_INVALID") from None
        frame = await self._control.execute(action)
        if (frame.width, frame.height) != self._size:
            raise BrowserRefused("BROWSER_VIEWPORT_CHANGED")
        return ComputerState(screenshot=frame.png, url=frame.url)

    async def open_web_browser(self) -> ComputerState:
        return await self.current_state()

    async def current_state(self) -> ComputerState:
        return await self._act("observe")

    async def click_at(self, x: int, y: int) -> ComputerState:
        return await self._act("click", x=x, y=y)

    async def hover_at(self, x: int, y: int) -> ComputerState:
        return await self._act("hover", x=x, y=y)

    async def type_text_at(
        self,
        x: int,
        y: int,
        text: str,
        press_enter: bool = False,
        clear_before_typing: bool = True,
    ) -> ComputerState:
        return await self._act(
            "type",
            x=x,
            y=y,
            text=text,
            press_enter=press_enter,
            clear_before_typing=clear_before_typing,
        )

    async def scroll_document(
        self, direction: Literal["up", "down", "left", "right"]
    ) -> ComputerState:
        return await self._act("scroll", direction=direction, magnitude=600)

    async def scroll_at(
        self,
        x: int,
        y: int,
        direction: Literal["up", "down", "left", "right"],
        magnitude: int,
    ) -> ComputerState:
        return await self._act("scroll", x=x, y=y, direction=direction, magnitude=magnitude)

    async def wait(self, seconds: int) -> ComputerState:
        if type(seconds) is not int or not 0 <= seconds <= 5:
            raise BrowserRefused("BROWSER_WAIT_LIMIT")
        # Fences/revocation are still checked before returning the observation.
        await asyncio.sleep(seconds)
        return await self.current_state()

    async def go_back(self) -> ComputerState:
        return await self._act("back")

    async def go_forward(self) -> ComputerState:
        return await self._act("forward")

    async def search(self) -> ComputerState:
        # No implicit search destination absent from the task grant.
        raise BrowserRefused("BROWSER_EXPLICIT_DESTINATION_REQUIRED")

    async def navigate(self, url: str) -> ComputerState:
        return await self._act("navigate", url=url)

    async def key_combination(self, keys: list[str]) -> ComputerState:
        return await self._act("keys", keys=tuple(keys))

    async def drag_and_drop(
        self, x: int, y: int, destination_x: int, destination_y: int
    ) -> ComputerState:
        return await self._act(
            "drag", x=x, y=y, destination_x=destination_x, destination_y=destination_y
        )

    async def close(self) -> None:
        await self._control.stop()
