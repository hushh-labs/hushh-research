"""adk_bridge package.

Importing this package registers the in-process A2A specialists so the central
chat's dispatch seam can reach them.
"""

from hushh_mcp.adk_bridge.dispatch import register_specialist


def _with_service(module_name, class_name):
    """Construct the same authored wrapper with runtime-provided dependencies."""

    async def invoke(task, service):
        from importlib import import_module

        wrapper = getattr(import_module(module_name), class_name)
        return await wrapper(service=service).handle(task)

    return invoke


async def _runtime_handle(task, service):
    return await service.handle(task)


def _register_builtin_specialists() -> None:
    # Every product specialist is registered and REACHABLE. What protects the
    # authority-sensitive ones is not their absence from this map -- it is their
    # own require_attenuated_authority guard, which fails closed unless the task
    # carries an ingress-validated A2AAuthorityContext with the exact grant,
    # export, and action refs that hop needs. One forwards a first-party
    # authority context (agent_tree._first_party_authority) carrying the
    # invocation capability only, so information- and action-gated specialists
    # still fail closed until real grant/export refs are threaded -- reachable,
    # self-guarding, and honest about what authority actually exists.
    #
    # Handlers are LAZY thunks: each imports its agent module on first dispatch,
    # never at package import. That keeps `import hushh_mcp.adk_bridge` (which any
    # `from hushh_mcp.adk_bridge.contract import ...` triggers) from eagerly
    # pulling the specialists' heavy dependency graph -- one that loops back
    # through agent_chat_service into a still-initializing agent_tree. The
    # registration itself is just name -> thunk and cannot cycle.
    def _location(task):
        from hushh_mcp.adk_bridge.location_agent import get_location_a2a

        return get_location_a2a().handle(task)

    def _nav(task):
        from hushh_mcp.adk_bridge.nav_agent import get_nav_a2a

        return get_nav_a2a().handle(task)

    def _personal_information(task):
        from hushh_mcp.adk_bridge.personal_information_agent import get_personal_information_a2a

        return get_personal_information_a2a().handle(task)

    def _email(task):
        from hushh_mcp.adk_bridge.email_agent import get_email_a2a

        return get_email_a2a().handle(task)

    def _connections(task):
        from hushh_mcp.adk_bridge.connections_agent import get_connections_a2a

        return get_connections_a2a().handle(task)

    def _connected_systems(task):
        from hushh_mcp.adk_bridge.connected_systems_agent import get_connected_systems_a2a

        return get_connected_systems_a2a().handle(task)

    register_specialist(
        "agent_location",
        _location,
        service_handler=_with_service("hushh_mcp.adk_bridge.location_agent", "LocationAgentA2A"),
    )
    register_specialist("agent_nav", _nav, service_handler=_runtime_handle)
    register_specialist(
        "agent_personal_information",
        _personal_information,
        service_handler=_with_service(
            "hushh_mcp.adk_bridge.personal_information_agent", "PersonalInformationAgentA2A"
        ),
    )
    register_specialist(
        "agent_email",
        _email,
        service_handler=_with_service("hushh_mcp.adk_bridge.email_agent", "EmailAgentA2A"),
    )
    register_specialist(
        "agent_connections",
        _connections,
        service_handler=_with_service(
            "hushh_mcp.adk_bridge.connections_agent", "ConnectionsAgentA2A"
        ),
    )
    register_specialist(
        "agent_connected_systems", _connected_systems, service_handler=_runtime_handle
    )


_register_builtin_specialists()
