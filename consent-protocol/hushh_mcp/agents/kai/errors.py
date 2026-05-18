"""
Typed error hierarchy for agent execution failures.

All agent files previously caught bare ``Exception`` and either swallowed it
silently or logged only the message string (losing the traceback).  This module
gives callers a stable set of types to ``except`` on so they can distinguish:

  * consent / auth failures: already typed as PermissionError (unchanged)
  * LLM / ADK call failures: AgentLLMError
  * data-fetch failures: AgentDataError
  * orchestration failures: AgentOrchestrationError

All three inherit from ``AgentExecutionError`` so a single broad ``except`` is
still possible when callers don't care about the sub-type.

Usage
    from hushh_mcp.agents.kai.errors import AgentExecutionError, AgentLLMError

    try:
        result = await agent.analyze(ticker, user_id, consent_token)
    except PermissionError:
        # consent/auth problem — return 401
        ...
    except AgentLLMError:
        # transient LLM failure — return 503 / retry
        ...
    except AgentExecutionError:
        # any other agent failure — return 500
        ...
"""

from __future__ import annotations


class AgentExecutionError(Exception):
    """
    Base class for all agent-pipeline failures.

    Always raised with ``raise AgentXxxError(...) from original_exc`` so the
    original traceback is preserved in the ``__cause__`` chain.
    """


class AgentLLMError(AgentExecutionError):
    """
    The LLM (Gemini / ADK) call itself failed or returned an unusable response.

    Examples: timeout, 429 rate-limit exhausted after retries, empty generation,
    malformed tool-call response.
    """


class AgentDataError(AgentExecutionError):
    """
    An upstream data fetch (SEC filings, market data, news) failed in an
    unexpected way — i.e. beyond the known ``RealtimeDataUnavailable`` path
    that is handled gracefully with a fallback.
    """


class AgentOrchestrationError(AgentExecutionError):
    """
    The orchestrator or debate engine failed to coordinate sub-agents.

    Examples: ``asyncio.gather`` returned only exceptions, debate stream
    produced no output for all agents, decision generator raised unexpectedly.
    """