"""Local full-app rehearsal with recorded model responses, never auth overrides.

The ordinary API, consent gates, PKM coordinator and database writers still run.
Only the external PKM model-contract seam is replaced, as in its unit suite.
"""

import json
import os
from pathlib import Path
from urllib.parse import urlsplit


def validate_fixture_environment():
    if os.getenv("ENVIRONMENT", "development") not in {"development", "local", "test"}:
        raise SystemExit("Fixture runtime cannot run in a hosted environment")
    if (
        os.getenv("DB_HOST") not in {"localhost", "127.0.0.1"}
        or not os.getenv("DB_NAME", "").startswith("hushh_profile_fixture_")
        or os.getenv("DB_UNIX_SOCKET")
    ):
        raise SystemExit("Fixture runtime requires an isolated local database")
    if urlsplit(os.getenv("INTELLIGENCE_API_BASE_URL", "")).hostname not in {
        "localhost",
        "127.0.0.1",
    }:
        raise SystemExit("Fixture runtime requires local HusshOne")


async def fixture_contract(self, *, manifest, prompt, execution_trace=None, **_kwargs):
    agent_id = manifest.id
    correction = "fixture:correction" in prompt or "Fixture Advisor" in prompt
    text = (
        "Owner-provided fixture correction: role is Fixture Advisor"
        if correction
        else "Synthetic fixture: works as Fixture Researcher"
    )
    common = {"source_agent": agent_id, "contract_version": 1}
    if execution_trace is not None:
        execution_trace.append(
            {
                "agent_id": agent_id,
                "status": "fixture",
                "attempts": 0,
                "latency_ms": 0,
                "error_type": "",
            }
        )
    if "segmentation" in agent_id:
        message = json.loads(prompt)["message"]
        text = "Fixture Advisor" if "Fixture Advisor" in message else "Works at Fixture Research"
        if text not in message:
            raise ValueError("Unsupported recorded profile fixture")
        return {
            **common,
            "segments": [
                {"source_text": text, "confidence": 1, "reason": "Recorded synthetic fixture"}
            ],
            "has_more_candidates": False,
        }
    if "guard" in agent_id:
        return {
            **common,
            "routing_decision": "non_financial_or_ephemeral",
            "confidence": 1,
            "reason": "Recorded synthetic professional fixture",
        }
    if "intent" in agent_id:
        return {
            **common,
            "save_class": "durable",
            "intent_class": "fact",
            "mutation_intent": "create",
            "requires_confirmation": False,
            "confirmation_reason": "Recorded unambiguous fixture; claim UI still requires owner confirmation",
            "candidate_domain_choices": [{"domain_key": "professional", "recommended": True}],
            "confidence": 1,
        }
    if "merge" in agent_id:
        return {
            **common,
            "merge_mode": "create_entity",
            "target_domain": "professional",
            "target_entity_id": "fixture_profile",
            "target_entity_path": "work.entities.fixture_profile",
            "match_confidence": 1,
            "match_reason": "Recorded synthetic fixture",
        }
    if "structure" in agent_id:
        return {
            **common,
            "candidate_payload": {
                "work": {
                    "entities": {
                        "fixture_profile": {
                            "role": "Fixture Advisor" if correction else "Fixture Researcher",
                            "employer": "Fixture Research",
                            "source": "owner_provided" if correction else "synthetic_public",
                        }
                    }
                }
            },
            "structure_decision": {
                "target_domain": "professional",
                "target_scope": "work",
                "action": "create_entity",
                "confidence": 1,
                "reason": "Recorded fixture",
                "externalizable_paths": [],
                "summary_projection": {},
                "sensitivity_labels": {"work": "private"},
            },
            "write_mode": "confirm_first",
            "target_entity_scope": "work",
            "primary_json_path": "work",
            "validation_hints": ["synthetic_model_fixture"],
        }
    raise RuntimeError("No recorded fixture for this model contract")


def main():
    validate_fixture_environment()
    # Read canonical reviewer settings into process memory, never write an overlay.
    from dotenv import dotenv_values

    base = Path(__file__).resolve().parents[2]
    for path in (base / "consent-protocol/.env", base / "hushh-webapp/.env.local"):
        for key, value in dotenv_values(path).items():
            if key in {"REVIEWER_UID", "REVIEWER_VAULT_PASSPHRASE"} and value:
                os.environ.setdefault(key, value)
    reviewer_email = os.getenv("PROFILE_FIXTURE_REVIEWER_EMAIL")
    if reviewer_email:
        from dotenv import load_dotenv

        load_dotenv(base / "consent-protocol/.env")
        from firebase_admin import auth

        from api.utils.firebase_admin import ensure_firebase_auth_admin, get_firebase_auth_app

        configured, _ = ensure_firebase_auth_admin()
        if not configured:
            raise SystemExit("Reviewer Firebase authentication is unavailable")
        os.environ["REVIEWER_UID"] = auth.get_user_by_email(
            reviewer_email, app=get_firebase_auth_app()
        ).uid
    from hushh_mcp.services.pkm_agent_lab_service import PKMAgentLabService

    PKMAgentLabService._run_agent_contract = fixture_contract
    # Replace only the external model probe. Auth, cloud choice, and scheduling
    # policy remain the ordinary runtime route; Shared must be chosen in the UI.
    from api.routes.one import runtime as runtime_routes

    async def fixture_probe():
        return runtime_routes.ManagedGeminiReadinessResponse(
            status="ready", model="fixture:managed-probe", location="local-fixture"
        )

    runtime_routes._probe_managed_gemini = fixture_probe
    import uvicorn

    from server import app

    @app.get("/api/one/profile-discovery/fixture-health")
    async def profile_fixture_health():
        # Registered only by this isolated launcher, never by the normal server.
        return {"fixture": True, "database": os.environ["DB_NAME"]}

    print(
        "Local profile fixture backend: model responses recorded; authentication and PKM writes remain enforced."
    )
    uvicorn.run(
        "server:app",
        host="127.0.0.1",
        port=int(os.getenv("PROFILE_FIXTURE_BACKEND_PORT", "8000")),
        log_level="warning",
    )


if __name__ == "__main__":
    main()
