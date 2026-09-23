import asyncio
import os
import sys
sys.path.append("consent-protocol")

from hushh_mcp.services.pkm_agent_lab_service import PKMAgentLabService

async def run():
    service = PKMAgentLabService()
    
    async def mock_run(*args, **kwargs):
        return {"facts": [
            {
                "field_id": "identity.identity_profile.full_name",
                "value": "akshat Kumar",
                "source_text": "My name is akshat Kumar",
                "confidence": 0.95
            },
            {
                "field_id": "identity.identity_profile.declared_age",
                "value": "22",
                "source_text": "I'm 22",
                "confidence": 0.95
            }
        ]}

    service._run_agent_contract = mock_run
    
    result = await service._generate_kyc_identity_preview(
        user_id="u1",
        message="My name is akshat Kumar, I'm 22 student at IIT Bombay, Doing mechanical engg 5th year.",
        current_domains=["identity"],
        model_override=None,
        execution_trace=None
    )
    import json
    print(json.dumps(result, indent=2))

asyncio.run(run())
