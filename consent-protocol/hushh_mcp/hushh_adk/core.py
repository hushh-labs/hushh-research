"""
Hushh ADK Base Agent

The base class for all HUSHH-compliant agents.
It wraps the Google ADK patterns but injects our strict security loop.
"""

import importlib
import logging
import uuid
from typing import Any, Dict, List, Optional

_ADK_AVAILABLE = False

try:
    # google.adk.model.ModelClient never existed in shipped ADK releases; the
    # old import of it silently forced the stub path even when ADK WAS
    # installed, so HushhAgent had been running on the dev stub in production.
    # Import only what actually exists so real ADK loads.
    from google.adk.agents import LlmAgent

    _ADK_AVAILABLE = True
except ImportError:
    # Fallback/stub for development context where ADK might not be installed yet.
    # The stub raises on .run() so that code paths that try to execute an agent
    # without Google ADK installed get an explicit, actionable error instead of
    # silently receiving None.

    class LlmAgent:  # type: ignore[no-redef]
        """Development stub for google.adk.agents.LlmAgent."""

        _INSTALL_HINT = (
            "Google ADK is not installed. Add 'google-adk' to your dependencies to use HushhAgent."
        )

        def __init__(self, **kwargs: Any) -> None:
            pass

        def run(self, **kwargs: Any) -> Any:  # pragma: no cover
            raise RuntimeError(self._INSTALL_HINT)


from hushh_mcp.consent.token import validate_token  # noqa: E402
from hushh_mcp.hushh_adk.context import HushhContext  # noqa: E402

logger = logging.getLogger(__name__)


class HushhAgent(LlmAgent):
    """
    Secure Wrapper around Google ADK LlmAgent.

    Enforces:
    1. Consent Token Validation at Entry
    2. Context Injection for Tools
    3. Structured Logging

    Typical usage
    -------------
    # From code
    agent = HushhAgent(name="kai", model="gemini-pro", tools=[my_tool], ...)

    # From a YAML manifest file
    agent = HushhAgent.from_manifest("agents/kai/manifest.yaml")
    """

    # ADK 2.x LlmAgent is a pydantic model with extra="forbid"; Hussh-specific
    # state must be declared as fields (plain attribute assignment raises).
    # Declared only when real ADK is present; the stub path keeps plain attrs.
    if _ADK_AVAILABLE:
        hushh_name: str = ""
        required_scopes: List[str] = []

    def __init__(
        self,
        name: str,
        model: Any,  # model name string or ADK model object
        tools: Optional[List[Any]] = None,
        system_prompt: str = "",
        required_scopes: Optional[List[str]] = None,
    ):
        """
        Initialize Secure Agent.

        Args:
            name: Agent identifier
            model: The LLM model name string (or ADK model object)
            tools: List of @hushh_tool decorated functions
            system_prompt: Core instruction
            required_scopes: List of scopes this agent MUST have to even start
        """
        tools = tools or []

        if _ADK_AVAILABLE:
            # ADK 2.x: name is a required pydantic field that must be a valid
            # Python identifier. Manifests carry display names ("Agent One",
            # "Test Agent"), so sanitize for ADK while hushh_name keeps the
            # original display identity. Manifest model entries may be an
            # AgentModelConfig object; ADK wants the model name string.
            adk_name = name if name.isidentifier() else _sanitize_agent_name(name)
            adk_model = model if isinstance(model, str) else getattr(model, "name", str(model))
            super().__init__(
                name=adk_name,
                model=adk_model,
                tools=tools,
                instruction=system_prompt,
                hushh_name=name,
                required_scopes=list(required_scopes or []),
            )
        else:
            super().__init__()
            self.hushh_name = name
            self.required_scopes = list(required_scopes or [])

    # ------------------------------------------------------------------
    # Factory
    # ------------------------------------------------------------------

    @classmethod
    def from_manifest(cls, path: str) -> "HushhAgent":
        """
        Construct a HushhAgent from a YAML manifest file.

        The manifest's ``tools[].py_func`` entries are dynamically imported and
        expected to be functions decorated with ``@hushh_tool``.  Any import
        failure raises ``ImportError`` with an actionable message.

        Args:
            path: Filesystem path to the agent YAML manifest.

        Returns:
            A fully initialised HushhAgent ready to call ``.run_turn()``.

        Raises:
            FileNotFoundError: if the YAML file does not exist.
            ValueError: if the YAML is malformed or violates the manifest schema.
            ImportError: if a tool ``py_func`` path cannot be imported.
        """
        from hushh_mcp.hushh_adk.manifest import ManifestLoader

        manifest = ManifestLoader.load(path)

        # Dynamically import each tool function declared in the manifest
        tool_funcs: List[Any] = []
        for tool_cfg in manifest.tools:
            func = _import_dotted_path(tool_cfg.py_func)
            tool_funcs.append(func)

        return cls(
            name=manifest.name,
            model=manifest.model,
            tools=tool_funcs,
            system_prompt=manifest.system_instruction,
            required_scopes=manifest.required_scopes,
        )

    # ------------------------------------------------------------------
    # Execution
    # ------------------------------------------------------------------

    async def run_turn(
        self,
        prompt: str,
        user_id: str,
        consent_token: str,
        vault_keys: Optional[Dict[str, str]] = None,
    ) -> Any:
        """
        Secure application-level execution entry point.

        This deliberately does not override ADK's internal ``BaseNode.run``
        protocol. Application callers go through a Runner while ADK remains
        free to call its own ``run(ctx, node_input)`` implementation.
        """
        logger.info("🤖 Agent '%s' invoked (user=[redacted])", self.hushh_name)

        # 1. Base Validation
        # Check if token allows accessing THIS agent
        is_valid = False
        last_reason = "No scopes defined"

        if not self.required_scopes:
            is_valid = True  # No specific agent-level scope needed, relying on tools
        else:
            for scope in self.required_scopes:
                valid, reason, _ = validate_token(consent_token, expected_scope=scope)
                if valid:
                    is_valid = True
                    break
                last_reason = reason

        if not is_valid:
            error_msg = f"⛔ Agent Access Denied: {last_reason}"
            logger.warning(error_msg)
            raise PermissionError(error_msg)

        # 2. Context injection stays process-local and non-model. Raw credentials
        # are never stored in ADK session state or event payloads.
        with HushhContext(
            user_id=user_id,
            consent_token=consent_token,
            vault_keys=vault_keys or {},
        ):
            try:
                return await self._execute_adk_turn(prompt=prompt, user_id=user_id)
            except Exception:
                logger.exception("Agent turn failed agent=%s", self.hushh_name)
                raise

    async def _execute_adk_turn(self, *, prompt: str, user_id: str) -> str:
        if not _ADK_AVAILABLE:
            raise RuntimeError(LlmAgent._INSTALL_HINT)

        from google.adk.runners import Runner
        from google.adk.sessions.in_memory_session_service import InMemorySessionService
        from google.genai import types as genai_types

        app_name = f"hushh_{self.name}"
        session_id = f"turn_{uuid.uuid4().hex}"
        session_service = InMemorySessionService()
        runner = Runner(app_name=app_name, agent=self, session_service=session_service)
        await session_service.create_session(
            app_name=app_name,
            user_id=user_id,
            session_id=session_id,
            state={},
        )
        content = genai_types.Content(
            role="user",
            parts=[genai_types.Part.from_text(text=prompt)],
        )
        final_text = ""
        async for event in runner.run_async(
            user_id=user_id,
            session_id=session_id,
            new_message=content,
        ):
            if not event.is_final_response() or not event.content:
                continue
            final_text = "".join(
                part.text for part in (event.content.parts or []) if isinstance(part.text, str)
            )
        return final_text


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------


def _sanitize_agent_name(name: str) -> str:
    """Convert a display name into a valid Python identifier for ADK.

    "Test Agent" -> "test_agent". Falls back to "hussh_agent" when nothing
    identifier-like survives sanitization.
    """
    cleaned = "".join(ch if ch.isalnum() or ch == "_" else "_" for ch in name.strip().lower())
    cleaned = cleaned.strip("_") or "hussh_agent"
    if cleaned[0].isdigit():
        cleaned = f"agent_{cleaned}"
    return cleaned


_TOOL_PACKAGE_PREFIX = "hushh_mcp."


def _import_dotted_path(dotted: str) -> Any:
    """
    Import a @hushh_tool decorated callable given its fully-qualified dotted path.

    Only paths within the ``hushh_mcp.*`` package are accepted. After import,
    the resolved object must carry the ``._hushh_tool = True`` marker set by
    the ``@hushh_tool`` decorator. Bare callables and the decorator object
    itself are rejected so that a YAML manifest cannot bind arbitrary code.

    Example::

        _import_dotted_path("hushh_mcp.agents.kai.tools.perform_fundamental_analysis")

    Raises:
        ImportError: if the path is outside the allowed package boundary, the
            module or attribute cannot be found, or the resolved object is not
            a @hushh_tool decorated callable.
    """
    if "." not in dotted:
        raise ImportError(
            f"'{dotted}' is not a valid fully-qualified dotted path "
            "(expected 'package.module.attribute')"
        )
    if not dotted.startswith(_TOOL_PACKAGE_PREFIX):
        raise ImportError(
            f"Tool path '{dotted}' is outside the allowed package boundary. "
            f"Only paths within '{_TOOL_PACKAGE_PREFIX}' are permitted in manifests."
        )
    module_path, attr_name = dotted.rsplit(".", 1)
    try:
        module = importlib.import_module(module_path)
    except ModuleNotFoundError as exc:
        raise ImportError(
            f"Could not import module '{module_path}' for tool '{dotted}': {exc}"
        ) from exc
    try:
        obj = getattr(module, attr_name)
    except AttributeError as exc:
        raise ImportError(
            f"Module '{module_path}' has no attribute '{attr_name}' (tool path: '{dotted}')"
        ) from exc
    if not getattr(obj, "_hushh_tool", False):
        raise ImportError(
            f"'{dotted}' is not a @hushh_tool decorated callable. "
            "Only functions decorated with @hushh_tool may be loaded via a manifest."
        )
    return obj
