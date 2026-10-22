"""adk_bridge package.

Importing this package registers the in-process A2A specialists so the central
chat's dispatch seam can reach them.
"""

from hushh_mcp.adk_bridge.dispatch import register_specialist, unregister_specialist
from hushh_mcp.adk_bridge.documents_agent import DocumentsAgentA2A
from hushh_mcp.adk_bridge.email_agent import get_email_a2a


def _with_service(module_name, class_name):
    """Construct the authored wrapper with runtime-provided dependencies."""

    async def invoke(task, service):
        from importlib import import_module

        wrapper = getattr(import_module(module_name), class_name)
        return await wrapper(service=service).handle(task)

    return invoke


async def _runtime_handle(task, service):
    return await service.handle(task)


def _register_builtin_specialists() -> None:
    for optional_id in ("agent_connections", "agent_connected_systems"):
        unregister_specialist(optional_id)

    # Every specialist remains reachable through a self-guarding A2A handler.
    # Runtime-bound dispatch supplies owner-scoped services; raw ingress still
    # fails closed at each handler's authority boundary.
    def _location(task):
        from hushh_mcp.adk_bridge.location_agent import get_location_a2a

        return get_location_a2a().handle(task)

    def _nav(task):
        from hushh_mcp.adk_bridge.nav_agent import get_nav_a2a

        return get_nav_a2a().handle(task)

    def _personal_information(task):
        from hushh_mcp.adk_bridge.personal_information_agent import get_personal_information_a2a

        return get_personal_information_a2a().handle(task)

    def _connections(task):
        from hushh_mcp.adk_bridge.connections_agent import get_connections_a2a

        return get_connections_a2a().handle(task)

    def _connected_systems(task):
        from hushh_mcp.adk_bridge.connected_systems_agent import get_connected_systems_a2a

        return get_connected_systems_a2a().handle(task)

    # Mail and Nav enforce independently bound, attenuated authority on every
    # hop. Connected Systems remains unwired; a raw One invocation token must
    # never reach an ambient user-id service method.
    register_specialist(
        "agent_documents",
        lambda task: DocumentsAgentA2A().handle(task),
        service_handler=_with_service("hushh_mcp.adk_bridge.documents_agent", "DocumentsAgentA2A"),
    )
    register_specialist(
        "agent_location",
        _location,
        service_handler=_with_service("hushh_mcp.adk_bridge.location_agent", "LocationAgentA2A"),
    )
    register_specialist("agent_nav", _nav, service_handler=_runtime_handle)
    register_specialist(
        "agent_email",
        lambda task: get_email_a2a().handle(task),
        service_handler=_with_service("hushh_mcp.adk_bridge.email_agent", "EmailAgentA2A"),
    )
    register_specialist(
        "agent_personal_information",
        _personal_information,
        service_handler=_with_service(
            "hushh_mcp.adk_bridge.personal_information_agent", "PersonalInformationAgentA2A"
        ),
    )
    # Connected Systems and Connections are wired only by the owner-bound pod.


def register_pod_specialists() -> None:
    """Register authority-sensitive specialists for one owner-bound pod turn."""

    def _email(task):
        from hushh_mcp.adk_bridge.email_agent import get_email_a2a

        return get_email_a2a().handle(task)

    def _connections(task):
        from hushh_mcp.adk_bridge.connections_agent import get_connections_a2a

        return get_connections_a2a().handle(task)

    def _connected_systems(task):
        from hushh_mcp.adk_bridge.connected_systems_agent import get_connected_systems_a2a

        return get_connected_systems_a2a().handle(task)

    register_specialist("agent_email", _email, service_handler=_runtime_handle)
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
