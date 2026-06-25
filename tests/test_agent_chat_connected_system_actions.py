from __future__ import annotations

from hushh_mcp.services.agent_chat_service import AgentChatService


def test_agent_planner_routes_crm_read_to_connected_systems():
    service = AgentChatService()

    plan = service.plan_action("read the Salesforce CRM contact for maria.joe@abc.com")

    assert plan is not None
    assert plan.action_id == "connected_system.crm.read"
    assert plan.execution == "frontend"
    assert plan.slots["systemId"] == "salesforce-fsc-customer0"
    assert plan.slots["objectType"] == "Contact"


def test_agent_planner_routes_crm_update_to_approval_proposal():
    service = AgentChatService()

    plan = service.plan_action("update the CRM record city to New York")

    assert plan is not None
    assert plan.action_id == "connected_system.crm.update.propose"
    assert plan.execution == "frontend"


def test_agent_planner_blocks_crm_delete_in_v1():
    service = AgentChatService()

    plan = service.plan_action("delete the Salesforce CRM contact record")

    assert plan is not None
    assert plan.action_id == "connected_system.crm.delete"
    assert plan.execution == "blocked"
    assert plan.reason == "crm_delete_manual_only"
