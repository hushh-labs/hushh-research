"""A model whose turns are a script, so the REAL agent tree can be exercised.

The existing runtime tests stub ADK's ``Runner``. That is correct for what they
test -- retry boundaries, timeouts, directive extraction -- but it means the
orchestration itself never runs: the component being stubbed is the component
that dispatches tools and delegates to specialists.

Scripting the *model* instead inverts that. ``LlmAgent.model`` accepts a
``BaseLlm``, so a scripted one drives the genuine tree: real tool declarations,
real dispatch, real ``AgentTool`` delegation into sub-agents, real conversation
state growing across turns. Nothing about orchestration is faked. What is faked
is only the part that would cost money and introduce nondeterminism.

The class also records what it was *asked*, which is where most of the harness's
observability comes from: the tools offered on each call reveal the tree's shape
at that moment, and the growth of ``contents`` across calls is the observable
signature of context propagation.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, AsyncGenerator, Union

from google.adk.models.base_llm import BaseLlm
from google.adk.models.llm_response import LlmResponse
from google.genai import types

#: One scripted step: either final text, a tool call, or a raised failure.
ToolCall = tuple[str, dict[str, Any]]
Step = Union[str, ToolCall, Exception]


@dataclass
class ModelCall:
    """What the tree asked the model for, on one call."""

    tools_offered: tuple[str, ...]
    content_count: int
    #: Roles present in the request, in order. A tool result arriving back as a
    #: `user`/`function` turn is what proves the loop actually closed.
    roles: tuple[str, ...]
    system_instruction_len: int


@dataclass
class ScriptedLlm(BaseLlm):
    """Deterministic stand-in for a Gemini model.

    Not a mock in the "assert it was called" sense -- it is a real participant in
    the ADK loop. It returns whatever the script says and the surrounding
    machinery treats that exactly as it would treat a live model's output.
    """

    model: str = "scripted"

    def __init__(self, script: list[Step] | None = None, *, tail: str = "Done.", **kwargs: Any) -> None:
        super().__init__(**kwargs)
        # BaseLlm is a pydantic model; bypass field validation for harness state.
        object.__setattr__(self, "_script", list(script or []))
        object.__setattr__(self, "_calls", [])
        object.__setattr__(self, "_tail", tail)
        object.__setattr__(self, "_schemas", {})
        object.__setattr__(self, "_root_signature", None)
        object.__setattr__(self, "_sub_agent_calls", [])

    @property
    def calls(self) -> list[ModelCall]:
        """Every model invocation this turn, in order."""
        return object.__getattribute__(self, "_calls")

    @property
    def script_remaining(self) -> int:
        return len(object.__getattribute__(self, "_script"))

    async def generate_content_async(
        self, llm_request: Any, stream: bool = False
    ) -> AsyncGenerator[LlmResponse, None]:
        self._record(llm_request)

        # One model instance serves the root agent AND every AgentTool-wrapped
        # specialist, because `build_one_text_agent` threads a single model down
        # the tree. A single shared script therefore gets consumed by whichever
        # agent happens to call next -- so a delegation into `finance` would eat
        # the step meant for the root, and the root's next call would dispatch
        # against the specialist's roster and fail with "tool not found".
        #
        # That is a harness bug that reads exactly like a product bug, which is
        # the worst kind. Routing by the caller's own tool set fixes it and makes
        # delegation depth observable at the same time.
        if not self._is_root(llm_request):
            sub_calls: list[str] = object.__getattribute__(self, "_sub_agent_calls")
            sub_calls.append(_agent_hint(llm_request))
            yield LlmResponse(
                content=types.Content(
                    role="model",
                    parts=[types.Part(text="Specialist answer.")],
                )
            )
            return

        script: list[Step] = object.__getattribute__(self, "_script")
        step: Step = script.pop(0) if script else object.__getattribute__(self, "_tail")

        if isinstance(step, Exception):
            # A model that fails mid-turn. This is the error-handling dimension:
            # the harness needs to see what the runtime does when the model
            # raises AFTER tools have already run, not only before.
            raise step

        if isinstance(step, tuple):
            name, args = step
            yield LlmResponse(
                content=types.Content(
                    role="model",
                    parts=[types.Part(function_call=types.FunctionCall(name=name, args=dict(args)))],
                )
            )
            return

        yield LlmResponse(content=types.Content(role="model", parts=[types.Part(text=str(step))]))

    @property
    def offered_schemas(self) -> dict[str, dict[str, Any]]:
        """Full tool schemas captured from the first call, for the generator."""
        return object.__getattribute__(self, "_schemas")

    @property
    def sub_agent_calls(self) -> list[str]:
        """Every call that came from a sub-agent rather than the root.

        This is the direct evidence of delegation actually happening. A journey
        that names `finance` and produces no sub-agent call delegated in name
        only.
        """
        return object.__getattribute__(self, "_sub_agent_calls")

    def _is_root(self, llm_request: Any) -> bool:
        """Is this call from Agent One, or from a specialist underneath it?

        The root is identified by the tool set of the FIRST call, which is
        always One -- every journey enters there by construction. Comparing tool
        sets is more robust than comparing names, because `LlmRequest` carries no
        agent identity at all.
        """
        signature = _tool_signature(llm_request)
        root = object.__getattribute__(self, "_root_signature")
        if root is None:
            object.__setattr__(self, "_root_signature", signature)
            return True
        return signature == root

    def _record(self, llm_request: Any) -> None:
        calls: list[ModelCall] = object.__getattribute__(self, "_calls")
        if not object.__getattribute__(self, "_schemas"):
            object.__setattr__(self, "_schemas", declared_schemas(llm_request))
        calls.append(
            ModelCall(
                tools_offered=_tool_names(llm_request),
                content_count=len(getattr(llm_request, "contents", None) or []),
                roles=tuple(
                    getattr(c, "role", "") or "" for c in (getattr(llm_request, "contents", None) or [])
                ),
                system_instruction_len=len(
                    getattr(getattr(llm_request, "config", None), "system_instruction", "") or ""
                ),
            )
        )


def _tool_names(llm_request: Any) -> tuple[str, ...]:
    """The tool names the tree actually declared to the model on this call.

    Read from the request rather than from the agent object, because the agent
    holds what was *configured* and the request holds what was *offered* -- and a
    tool that is configured but never offered is precisely the kind of silent
    wiring gap this harness exists to catch.
    """
    return tuple(sorted(declared_schemas(llm_request)))


def _tool_signature(llm_request: Any) -> frozenset[str]:
    """The set of tools available to whichever agent issued this request."""
    return frozenset((getattr(llm_request, "tools_dict", None) or {}).keys())


def _agent_hint(llm_request: Any) -> str:
    """A readable label for a sub-agent call, from the tools it can see."""
    names = sorted(_tool_signature(llm_request))
    return "+".join(names) if names else "leaf"


def declared_schemas(llm_request: Any) -> dict[str, dict[str, Any]]:
    """Full JSON schema per offered tool, as the model itself receives it.

    Asking the tool objects for their declarations returns nothing useful here --
    ADK builds them during request assembly, not on the tool. Reading the
    assembled request is therefore not a workaround, it is the only place the
    real contract exists, and it is the same bytes the model is given.
    """
    config = getattr(llm_request, "config", None)
    schemas: dict[str, dict[str, Any]] = {}
    for tool in getattr(config, "tools", None) or []:
        for declaration in getattr(tool, "function_declarations", None) or []:
            name = getattr(declaration, "name", None)
            if not name:
                continue
            params = getattr(declaration, "parameters", None)
            dumped: dict[str, Any] = {}
            if params is not None and hasattr(params, "model_dump"):
                dumped = params.model_dump(exclude_none=True, mode="json") or {}
            schemas[str(name)] = {
                "description": getattr(declaration, "description", "") or "",
                "parameters": dumped,
            }
    return schemas


@dataclass
class ToolLedger:
    """Every tool the REAL tree dispatched, recovered from the event stream.

    Derived from ADK events rather than from instrumentation we inject, so it
    reports what the runtime did and not what the harness hoped it would do.
    """

    calls: list[str] = field(default_factory=list)
    responses: list[str] = field(default_factory=list)
    errors: list[str] = field(default_factory=list)
    #: ``tool -> status`` for every response that reported one.
    #:
    #: Without this, a tool that ran and did its job is indistinguishable from a
    #: tool that ran and politely declined -- both appear as one call and one
    #: response. That ambiguity hid the reason session state stayed empty across
    #: an entire run: the goal tools were being reached and were refusing,
    #: which is a completely different report than "the goal tools work".
    statuses: list[tuple[str, str]] = field(default_factory=list)

    def observe(self, event: Any) -> None:
        content = getattr(event, "content", None)
        for part in getattr(content, "parts", None) or []:
            call = getattr(part, "function_call", None)
            if call is not None and getattr(call, "name", None):
                self.calls.append(str(call.name))
            response = getattr(part, "function_response", None)
            if response is not None and getattr(response, "name", None):
                name = str(response.name)
                self.responses.append(name)
                payload = getattr(response, "response", None)
                if isinstance(payload, dict):
                    if payload.get("error"):
                        self.errors.append(f"{name}: {payload['error']}")
                    status = payload.get("status")
                    if status is not None:
                        self.statuses.append((name, str(status)))

    @property
    def declined(self) -> list[tuple[str, str]]:
        """Tools that ran but reported a non-success status."""
        return [(n, s) for n, s in self.statuses if s.lower() not in {"ok", "success", "completed"}]

    @property
    def unanswered(self) -> list[str]:
        """Tools called whose result never came back.

        A dangling call is invisible in a transcript -- the agent simply moves on
        -- which is why it gets its own field rather than being left for a reader
        to notice.
        """
        remaining = list(self.responses)
        missing: list[str] = []
        for name in self.calls:
            if name in remaining:
                remaining.remove(name)
            else:
                missing.append(name)
        return missing


__all__ = ["ScriptedLlm", "ModelCall", "ToolLedger", "Step", "ToolCall"]
