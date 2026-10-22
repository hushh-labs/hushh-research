"""Current native Gemini browser verbs through ADK's Computer Use extension.

Pinned ADK also retains the legacy BaseComputer names. New provider verbs are
wire aliases of the same consented port, never a second browser or action owner.
Unsupported native actions fail before ADK can send an invalid error response.
"""

from typing import Literal, cast

from google.adk.agents.callback_context import CallbackContext
from google.adk.models.llm_request import LlmRequest
from google.adk.models.llm_response import LlmResponse
from google.adk.tools.computer_use.base_computer import ComputerState
from google.adk.tools.computer_use.computer_use_tool import ComputerUseTool
from google.adk.tools.computer_use.computer_use_toolset import ComputerUseToolset
from google.adk.tools.tool_context import ToolContext

from .adk_computer import PodComputer
from .contracts import BrowserRefused
from .control import BrowserControl

_LEGACY = frozenset(
    {
        "open_web_browser",
        "current_state",
        "click_at",
        "hover_at",
        "type_text_at",
        "scroll_document",
        "scroll_at",
        "go_back",
        "go_forward",
        "search",
        "navigate",
        "key_combination",
        "drag_and_drop",
        "wait_5_seconds",
    }
)
_NATIVE = frozenset({"take_screenshot", "click", "move", "scroll", "hotkey"})


class GeminiBrowserToolset(ComputerUseToolset):
    def __init__(self, *, computer: PodComputer) -> None:
        # Native exclusions use provider-specific verb names. Local authorization
        # remains authoritative, including refusal of implicit search destinations.
        super().__init__(computer=computer)
        self._port = computer
        self._native: dict[str, ComputerUseTool] | None = None

    async def prepare_continuation(self) -> None:
        self._tools = None
        self._native = None
        await self._port.screen_size()

    async def get_tools(self, readonly_context=None):
        # The pinned SDK discovers BaseComputer.initialize as a callable, but
        # it is lifecycle, not a native model action. Its search method also
        # lacks a task-authorized destination. Filter local discovery without
        # sending unsupported exclusion names to the provider API.
        tools = await super().get_tools(readonly_context)
        return [tool for tool in tools if tool.name not in {"initialize", "search"}]

    async def process_llm_request(
        self, *, tool_context: ToolContext, llm_request: LlmRequest
    ) -> None:
        await super().process_llm_request(tool_context=tool_context, llm_request=llm_request)
        if self._native is None:
            self._native = self._native_tools(await self._port.screen_size())
        llm_request.tools_dict.update(self._native)

    def _native_tools(self, size: tuple[int, int]) -> dict[str, ComputerUseTool]:
        port = self._port

        async def take_screenshot(intent: str = "") -> ComputerState:
            return await port.current_state()

        async def click(x: int, y: int, intent: str = "") -> ComputerState:
            return await port.click_at(x, y)

        async def move(x: int, y: int, intent: str = "") -> ComputerState:
            return await port.hover_at(x, y)

        async def scroll(
            x: int, y: int, direction: str, magnitude_in_pixels: int = 300, intent: str = ""
        ) -> ComputerState:
            if direction not in {"up", "down", "left", "right"}:
                raise BrowserRefused("BROWSER_ACTION_INVALID")
            return await port.scroll_at(
                x, y, cast(Literal["up", "down", "left", "right"], direction), magnitude_in_pixels
            )

        async def hotkey(keys: list[str], intent: str = "") -> ComputerState:
            return await port.key_combination(keys)

        async def navigate(url: str, intent: str = "") -> ComputerState:
            return await port.navigate(url)

        async def go_back(intent: str = "") -> ComputerState:
            return await port.go_back()

        async def go_forward(intent: str = "") -> ComputerState:
            return await port.go_forward()

        return {
            function.__name__: ComputerUseTool(func=function, screen_size=size)
            for function in (
                take_screenshot,
                click,
                move,
                scroll,
                hotkey,
                navigate,
                go_back,
                go_forward,
            )
        }


def gemini_after_model(control: BrowserControl):
    async def after_model(callback_context: CallbackContext, llm_response: LlmResponse) -> None:
        await control.require_model_observation()
        for part in llm_response.content.parts or [] if llm_response.content else []:
            call = part.function_call
            if call is None:
                continue
            if call.name not in _LEGACY | _NATIVE | {"finish_task"}:
                raise BrowserRefused("BROWSER_NATIVE_ACTION_UNSUPPORTED")
            if call.name == "drag_and_drop" and any(
                name in (call.args or {}) for name in ("start_x", "start_y", "end_x", "end_y")
            ):
                # The provider's new drag schema is not the pinned ADK schema.
                # Refuse before ADK can reinterpret or partially execute it.
                raise BrowserRefused("BROWSER_NATIVE_ACTION_UNSUPPORTED")
            # ADK's coordinate adapter clamps values; refuse malformed native
            # coordinates before a changed click could be delivered instead.
            if call.name in _NATIVE:
                arguments = call.args or {}
                for name in ("x", "y"):
                    if name in arguments and (
                        type(arguments[name]) is not int or not 0 <= arguments[name] <= 999
                    ):
                        raise BrowserRefused("BROWSER_COORDINATES_INVALID")
        return None

    return after_model
