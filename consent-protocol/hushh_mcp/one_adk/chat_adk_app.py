"""Canonical ADK App setup for resumable private-agent chat."""

from __future__ import annotations

import inspect
import os
from typing import Any

from google.adk.agents import BaseAgent, LlmAgent
from google.adk.apps import App, ResumabilityConfig
from google.adk.models.google_llm import Gemini
from google.adk.plugins.base_plugin import BasePlugin
from google.adk.tools import FunctionTool
from google.genai import types as genai_types

from hushh_mcp.one_adk.finance_a2ui import (
    dev_finance_presentation_enabled,
    send_a2ui_json_to_client,
)
from hushh_mcp.one_adk.tool_retry_plugin import SafeSchemaRetryToolPlugin
from hushh_mcp.services.generated_contracts import generated_contract_path

try:
    from google.adk.agents.context_cache_config import ContextCacheConfig
except ImportError:  # pragma: no cover - older google-adk runtimes lack ContextCacheConfig
    ContextCacheConfig = None  # type: ignore[assignment,misc]

_APP_ACCEPTS_CONTEXT_CACHE = "context_cache_config" in inspect.signature(App).parameters


def _adk_context_cache_config(root_agent: Any) -> Any | None:
    """Enable ADK implicit prompt/tool context caching only when supported on native Gemini."""
    if ContextCacheConfig is None or not _APP_ACCEPTS_CONTEXT_CACHE:
        return None
    if os.getenv("HUSHH_ADK_CONTEXT_CACHE_DISABLED", "").strip().lower() in {
        "1",
        "true",
        "yes",
    }:
        return None
    if os.getenv("PYTEST_CURRENT_TEST") and os.getenv("HUSHH_ADK_CONTEXT_CACHE_FORCE_TEST") != "1":
        return None
    from hushh_mcp.runtime_settings import pod_sentinel_model_enabled

    if pod_sentinel_model_enabled():
        return None
    model = getattr(root_agent, "model", None)
    supports_gemini_cache = (isinstance(model, str) and model.startswith("gemini-")) or (
        type(model) is Gemini and not getattr(model, "use_interactions_api", False)
    )
    if not supports_gemini_cache:
        return None
    params = inspect.signature(ContextCacheConfig).parameters
    kwargs: dict[str, Any] = {
        "min_tokens": 4096,
        "ttl_seconds": 1800,
        "cache_intervals": 10,
        "create_http_options": genai_types.HttpOptions(timeout=5000),
    }
    return ContextCacheConfig(**{k: v for k, v in kwargs.items() if k in params})


def build_chat_adk_app(
    root_agent: BaseAgent,
    *,
    app_name: str,
    plugins: list[BasePlugin] | None = None,
) -> App:
    resolved_plugins = list(plugins or [])
    if not any(isinstance(plugin, SafeSchemaRetryToolPlugin) for plugin in resolved_plugins):
        resolved_plugins.append(SafeSchemaRetryToolPlugin())
    return App(
        name=app_name,
        root_agent=root_agent,
        plugins=resolved_plugins,
        resumability_config=ResumabilityConfig(is_resumable=True),
        **(
            {"context_cache_config": cache}
            if (cache := _adk_context_cache_config(root_agent)) is not None
            else {}
        ),
    )


def build_native_visual_chat_app(
    root_agent: LlmAgent,
    *,
    app_name: str,
    plugins: list[BasePlugin] | None = None,
    finance_only: bool = False,
) -> App:
    """Attach the visual presenter to a fresh, top-level private agent."""
    if root_agent.name != "one" or root_agent.parent_agent is not None:
        raise ValueError("Only the top-level private agent can compose A2UI surfaces.")

    if finance_only:
        if not dev_finance_presentation_enabled():
            raise ValueError("The Finance presenter is available only in Dev.")
        presenter = FunctionTool(send_a2ui_json_to_client)
        if any(getattr(tool, "name", None) == presenter.name for tool in root_agent.tools):
            raise ValueError("The visual tool is already attached.")
    else:
        presenter = _official_visual_presenter(root_agent)

    legacy_finance_cards = {
        "show_portfolio_card",
        "show_portfolio_upload",
        "show_market_gainers",
        "show_stock_preview",
    }
    root_agent.tools = [
        tool
        for tool in root_agent.tools
        if getattr(tool, "__name__", None) not in legacy_finance_cards
    ]
    root_agent.tools.append(presenter)
    return build_chat_adk_app(root_agent, app_name=app_name, plugins=plugins)


def _official_visual_presenter(root_agent: LlmAgent):
    from a2ui.adk import SendA2uiToClientToolset
    from a2ui.inference_formats import DirectJsonFormatFactory
    from a2ui.processor import A2uiRequestProcessor, CatalogConfig

    if any(isinstance(tool, SendA2uiToClientToolset) for tool in root_agent.tools):
        raise ValueError("The visual tool is already attached.")
    catalog = CatalogConfig.from_path(
        str(generated_contract_path("a2ui", "morphy-one.v1.catalog.json"))
    ).catalog
    # Renderer state and credentials stay outside the processor.
    processor = A2uiRequestProcessor([catalog], format_factory=DirectJsonFormatFactory())
    return SendA2uiToClientToolset(
        a2ui_enabled=lambda context: context.agent_name == root_agent.name,
        a2ui_processor=processor,
    )
