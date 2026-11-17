"""Load the Drive request planner before an owner's Allow needs it."""

from __future__ import annotations

from pathlib import Path


def warm_semantic_request_planner() -> None:
    """Build the request planner once on a new worker instance, without using it.

    In UAT the first plan on an instance otherwise loads the managed Azure
    transport. Before the auth leaf became import-safe, its workload identity
    eagerly imported the full One action tree. On 2026-10-30 that cold load took
    45-80 s per instance under drain load, inside the search budget; the budget cancelled it twice and the first allowed request waited
    five minutes for its search to start. This builds the same agent with no model
    call, owner or request, and fetches no credential, so that one-time load is
    done before the first plan. Each plan still builds its own agent and model and
    fetches its own token. Outside UAT's managed policy the planner keeps its
    default model and loads none of the Azure transport.
    """
    from hushh_mcp.hushh_adk.manifest import ManifestLoader
    from hushh_mcp.hushh_adk.single_turn import build_single_turn_agent
    from hushh_mcp.services import drive_suggestion_service as planner

    manifest = ManifestLoader.load(
        str(Path(planner.__file__).resolve().parents[1] / "agents/documents/agent.yaml")
    )
    gene = next(
        child for child in manifest.subagents if child.id == "agent_documents_request_search"
    )
    try:
        from hushh_mcp.runtime_providers.managed_text import build_managed_text_model

        model = build_managed_text_model(scope="drive_document_requests")
    except ValueError:
        model = None  # Outside UAT's managed policy the planner keeps its default model.
    else:
        from openai import AsyncOpenAI  # noqa: F401 - the Azure transport imports this per call
    build_single_turn_agent(
        gene,
        output_schema=planner.SemanticLiveSearchModelPlan,
        **({"model": model} if model is not None else {}),
    )
