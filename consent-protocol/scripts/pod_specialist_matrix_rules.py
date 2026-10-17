"""Import-safe declaration/derived-fact rules for the owning matrix generator."""

from typing import Any

INFORMATION_SOURCES = ("pkm_projection", "hub_door", "none", "hub", "owner_bucket", "unavailable")
WRITE_SCOPES = ("none", "proposal_only", "confirmed_action")
CONFIRMATION_OWNERS = ("owner_browser", "owner", "none", "hub")
DECLARATION_FIELDS = (
    "executes_in_pod",
    "information_source",
    "write_scope",
    "confirmation_owner",
    "why",
)


def _validate_declaration(agent_id: str, declared: dict[str, Any]) -> tuple[list[str], bool]:
    problems: list[str] = []
    missing = [field for field in DECLARATION_FIELDS if field not in declared]
    if missing:
        return [f"{agent_id}: declaration is missing {', '.join(missing)}"], False
    executes = declared["executes_in_pod"]
    source = declared["information_source"]
    if not isinstance(executes, bool):
        problems.append(f"{agent_id}: executes_in_pod must be a bool")
        return problems, False
    if source not in INFORMATION_SOURCES:
        problems.append(f"{agent_id}: information_source {source!r} is not in the vocabulary")
    if declared["write_scope"] not in WRITE_SCOPES:
        problems.append(
            f"{agent_id}: write_scope {declared['write_scope']!r} is not in the vocabulary"
        )
    if declared["confirmation_owner"] not in CONFIRMATION_OWNERS:
        problems.append(
            f"{agent_id}: confirmation_owner {declared['confirmation_owner']!r} "
            "is not in the vocabulary"
        )
    if not str(declared["why"] or "").strip():
        problems.append(f"{agent_id}: why must say why")

    return problems, True


def check_row(agent_id: str, declared: dict[str, Any], derived: dict[str, Any]) -> list[str]:
    problems, usable = _validate_declaration(agent_id, declared)
    if not usable:
        return problems
    executes, source = declared["executes_in_pod"], declared["information_source"]
    if agent_id == "agent_one":
        # The routing head is served by the pod turn route, not by service_for.
        if not executes:
            problems.append("agent_one: the routing head runs in the pod turn route")
        if source != "pkm_projection":
            problems.append("agent_one: the head grounds on the PKM projection")
        return problems

    if source == "unavailable":
        if executes or any(
            derived.get(field)
            for field in (
                "pod_dispatchable",
                "pod_agent_tool",
                "registered_specialist",
                "hub_doors",
                "door",
            )
        ):
            problems.append(
                f"{agent_id}: unavailable cannot hide a registered execution or information path"
            )
        return problems

    if derived.get("pod_agent_tool"):
        if not executes or source != "owner_bucket":
            problems.append(
                f"{agent_id}: local Files AgentTool requires pod execution and owner_bucket custody"
            )
        return problems

    if executes != derived["pod_dispatchable"]:
        problems.append(
            f"{agent_id}: declared executes_in_pod={executes} but service_for "
            f"{'accepts' if derived['pod_dispatchable'] else 'refuses'} it"
        )
        return problems
    if executes:
        reads_hub = bool(derived["hub_doors"])
        if reads_hub and source != "hub_door":
            problems.append(
                f"{agent_id}: its pod port reads the hub door(s) {derived['hub_doors']} "
                f"but information_source is {source!r}"
            )
        if not reads_hub and source == "hub_door":
            problems.append(
                f"{agent_id}: declared hub_door but no pod port reads a hub door for it"
            )
        if source == "hub":
            problems.append(f"{agent_id}: executes in the pod, so 'hub' is not its source")
    else:
        expected = "hub_door" if derived["door"] else "hub"
        if source != expected:
            problems.append(
                f"{agent_id}: not pod-dispatchable, so information_source must be "
                f"{expected!r} (door={derived['door']!r}), not {source!r}"
            )
    return problems
