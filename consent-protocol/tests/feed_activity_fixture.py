"""Cross-subagent source arrangements over the shared isolated Feed database."""

import json
import uuid

import pytest
from sqlalchemy import text

from tests.test_feed_account_session_postgres import OTHER, OWNER


def _install_cross_agent_sources(feed_db, grant, request, bundle, workflow):
    with feed_db.begin() as conn:
        conn.execute(
            text("""
            CREATE TABLE consent_audit(id BIGINT PRIMARY KEY,user_id TEXT,request_id TEXT,action TEXT,metadata JSONB);
            CREATE TABLE one_information_request_bundles(bundle_id UUID PRIMARY KEY,subject_user_id TEXT,requester_user_id TEXT);
            CREATE TABLE one_information_request_items(request_id TEXT PRIMARY KEY,bundle_id UUID);
            CREATE TABLE one_location_access_requests(id UUID PRIMARY KEY,owner_user_id TEXT,requester_user_id TEXT);
            CREATE TABLE gmail_owner_send_actions(action_id TEXT PRIMARY KEY,user_id TEXT,state TEXT);
            CREATE TABLE gmail_personal_information_requests(workflow_id UUID PRIMARY KEY,user_id TEXT,status TEXT,reply_send_action_id TEXT);
            CREATE TABLE google_provider_connections(user_id TEXT,provider TEXT,status TEXT);
            CREATE TABLE google_service_grants(user_id TEXT,provider TEXT,service TEXT,status TEXT);
            CREATE TABLE kai_gmail_connections(user_id TEXT,status TEXT);
            CREATE TABLE user_external_connector_connections(user_id TEXT,connector_id TEXT,connection_generation BIGINT,status TEXT);
        """)
        )
        conn.execute(
            text("""INSERT INTO one_location_share_grants(id,owner_user_id,recipient_user_id,recipient_key_id,status)
            VALUES(:grant,:other,:owner,'test-recipient-key','revoked');
            INSERT INTO one_location_access_requests VALUES(:request,:other,:owner);
            INSERT INTO one_information_request_bundles VALUES(:bundle,:owner,:other);
            INSERT INTO one_information_request_items VALUES('request-a',:bundle);
            INSERT INTO consent_audit VALUES(1,:owner,'request-a','REQUESTED','{}'),(2,:owner,'request-a','CONSENT_GRANTED','{}');
            INSERT INTO gmail_owner_send_actions VALUES('kyc-send',:owner,'sent'),('email-send',:owner,'sent'),('foreign-send',:other,'sent');
            INSERT INTO gmail_personal_information_requests VALUES(:workflow,:owner,'sent','kyc-send');
            INSERT INTO google_provider_connections VALUES(:owner,'google','connected');
            INSERT INTO google_service_grants VALUES(:owner,'google','calendar','needs_reauth');
            INSERT INTO kai_gmail_connections VALUES(:owner,'error');
            INSERT INTO user_external_connector_connections VALUES(:owner,'test:connector',2,'needs_reauth');
        """),
            dict(
                grant=grant,
                request=request,
                bundle=bundle,
                workflow=workflow,
                owner=OWNER,
                other=OTHER,
            ),
        )


@pytest.fixture
def cross_agent_activity(feed_db):
    grant, request, bundle, workflow = [str(uuid.uuid4()) for _ in range(4)]
    _install_cross_agent_sources(feed_db, grant, request, bundle, workflow)

    def event(kind, domain, source, *, actor="Alex", day="01", metadata=None):
        with feed_db.begin() as conn:
            return conn.execute(
                text("""INSERT INTO feed_events(user_id,event_type,source_domain,source_row_id,actor_label,metadata,created_at)
                VALUES(:owner,:kind,:domain,:source,:actor,CAST(:meta AS jsonb),CAST(:date AS timestamptz)) RETURNING id"""),
                dict(
                    owner=OWNER,
                    kind=kind,
                    domain=domain,
                    source=source,
                    actor=actor,
                    meta=json.dumps(metadata or {}),
                    date=f"2026-10-{day}T12:00:00Z",
                ),
            ).scalar_one()

    first_grant = event("location_share_created", "location", grant)
    ended_grant = event("location_share_revoked", "location", grant, day="03")
    event("location_access_request", "location", request + ":revision:1")
    approved = event("location_access_approved", "location", request, day="03")
    event("consent_requested", "consent", "1")
    consent = event("consent_granted", "consent", "2", day="03")
    event("mail_information_request_detected", "connected_systems", workflow)
    sent = event("mail_message_sent", "connected_systems", "kyc-send", day="03")
    email = event("mail_message_sent", "connected_systems", "email-send", day="03")
    foreign = event("mail_message_sent", "connected_systems", "foreign-send", day="03")
    calendar = event(
        "calendar_reconnect_required", "connected_systems", "calendar-grant:needs_reauth:current"
    )
    gmail = event("mail_reconnect_required", "connected_systems", "mail-connection:error:current")
    stale = event(
        "connector_reconnect_required", "connected_systems", "test:connector:1:needs_reauth"
    )
    external = event(
        "connector_reconnect_required", "connected_systems", "test:connector:2:needs_reauth"
    )
    noise = event("mail_sync_completed", "connected_systems", "sync-1")
    with feed_db.begin() as conn:
        conn.execute(
            text("UPDATE feed_events SET metadata='[]'::jsonb WHERE id=:id"), {"id": first_grant}
        )

    return {
        "db": feed_db,
        "event": event,
        "grant": grant,
        "request": request,
        "bundle": bundle,
        "workflow": workflow,
        "first_grant": first_grant,
        "ended_grant": ended_grant,
        "approved": approved,
        "consent": consent,
        "sent": sent,
        "email": email,
        "foreign": foreign,
        "calendar": calendar,
        "gmail": gmail,
        "stale": stale,
        "external": external,
        "noise": noise,
    }


@pytest.fixture
def ranked_search_activity(cross_agent_activity):
    scenario = cross_agent_activity
    for index in range(80):
        scenario["event"](
            "connection_accepted", "connections", f"newer-{index}", actor="Unrelated", day="03"
        )
    exact = scenario["event"](
        "location_share_expired", "location", str(uuid.uuid4()), actor="Ankit", day="01"
    )
    prefixes = [
        scenario["event"](
            "location_share_expired",
            "location",
            str(uuid.uuid4()),
            actor="Ankit Kumar Singh",
            day="02",
        )
        for _ in range(23)
    ]
    return {**scenario, "exact": exact, "prefixes": prefixes}
