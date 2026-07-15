import httpx

from hussh_sdk.client import HusshClient
from hussh_sdk.credentials import (
    CredentialResolver,
    RuntimeCredentialBundle,
)
from hussh_sdk.credentials import (
    prepare_runtime_credentials as prepare_runtime_credentials_for,
)
from hussh_sdk.errors import ConsentRevokedError, RuntimeConfigError
from hussh_sdk.models import RuntimeConfig, runtime_config
from hussh_sdk.runtime import RuntimeAdapter, RuntimeRequest


class HusshAgent:
    def __init__(
        self,
        api_key: str = "sandbox",
        endpoint: str = "https://api.hussh.ai/v1",
        mock_mode: bool = False,
        mock_persona: str = "Manish",
        sandbox_persona: str | None = None,
        subject_ua: str = "ua_sandbox",
        relying_service: str | None = None,
        transport: httpx.AsyncBaseTransport | None = None,
        runtime_config: RuntimeConfig | None = None,
        runtime_adapter: RuntimeAdapter | None = None,
        credential_resolver: CredentialResolver | None = None,
    ):
        self.client = HusshClient(api_key=api_key, endpoint=endpoint, transport=transport)
        self.mock_mode = mock_mode
        self.mock_persona = mock_persona
        self.sandbox_persona = sandbox_persona
        self.subject_ua = subject_ua
        self.relying_service = relying_service or self.__class__.__name__
        self.runtime_config = runtime_config or runtime_config_for_mock(mock_mode)
        self.runtime_adapter = runtime_adapter
        self.credential_resolver = credential_resolver
        self.execution_events: list[dict] = []
        self.mock_events = self.execution_events

    async def know(self, domain: str, reason: str, fields: list[str] | None = None) -> dict | None:
        """
        Read from the Vault. Nav-gated — user must approve before data is returned.
        Returns data if approved, None if declined.
        Always handle the None case.
        """
        if self.mock_mode:
            return self._mock_know(domain=domain, reason=reason, fields=fields or [])

        return await self._real_know(domain=domain, reason=reason, fields=fields or [])

    async def do(self, action: str, preview: str, confirm: bool = True) -> bool:
        """
        Take an action with one-tap user confirmation.
        Returns True if confirmed, False if cancelled.
        """
        if self.mock_mode:
            self.mock_events.append(
                {
                    "label": "agent.do()",
                    "actor": "Hussh SDK",
                    "status": "approved",
                    "detail": "Mock mode auto-confirms non-context actions.",
                    "data": {"action": action, "preview": preview, "confirm": confirm},
                }
            )
            return True

        raise NotImplementedError("Real HusshAgent.do() API mode is not implemented yet.")

    async def remember(self, content: str, domain: str) -> bool:
        """
        Write to the Vault with consent.
        Returns True if written, False if declined.
        """
        if self.mock_mode:
            approved = self.mock_persona != "Priya"
            self.mock_events.append(
                {
                    "label": "agent.remember()",
                    "actor": "Hussh SDK",
                    "status": "approved" if approved else "declined",
                    "detail": "Mock mode simulates write consent.",
                    "data": {"domain": domain, "content": content},
                }
            )
            return approved

        raise NotImplementedError("Real HusshAgent.remember() API mode is not implemented yet.")

    async def run(
        self,
        prompt: str,
        *,
        context: dict | None = None,
        metadata: dict | None = None,
    ):
        """
        Execute the selected runtime with already-approved context.
        Use know() first when personal context is needed.
        """
        if self.runtime_adapter is None:
            raise NotImplementedError(
                f"Runtime '{self.runtime_config.kind}' is not configured yet."
            )

        result = await self.runtime_adapter.run(
            RuntimeRequest(
                prompt=prompt,
                context=context or {},
                metadata=metadata or {},
            )
        )
        self.execution_events.append(
            {
                "label": "Runtime executed",
                "actor": "Hussh SDK",
                "status": "completed",
                "detail": "The selected runtime adapter executed using caller-provided approved context.",
                "data": result.metadata,
            }
        )
        return result.output

    def describe_runtime(self) -> dict:
        if self.runtime_adapter is not None:
            return self.runtime_adapter.describe()
        return self.runtime_config.describe()

    async def prepare_runtime_credentials(
        self,
        *,
        resolver: CredentialResolver | None = None,
        required: bool = True,
    ) -> RuntimeCredentialBundle:
        credential_resolver = resolver or self.credential_resolver
        if credential_resolver is None:
            raise RuntimeConfigError(
                "A credential resolver is required for BYOK runtime credentials."
            )
        return await prepare_runtime_credentials_for(
            self.runtime_config,
            resolver=credential_resolver,
            required=required,
        )

    async def close(self) -> None:
        await self.client.close()

    async def _real_know(self, domain: str, reason: str, fields: list[str]) -> dict | None:
        self.execution_events.append(
            {
                "label": f"agent.know({domain})",
                "actor": self.__class__.__name__,
                "status": "requested",
                "detail": "The generated agent asks the Hussh SDK for one declared scope.",
                "pchp_phase": "Offer",
                "data": {
                    "domain": domain,
                    "fields": fields,
                    "reason": reason,
                    "access": "read",
                    "ttl_seconds": 3600,
                    "retention": "no-store",
                },
            }
        )
        payload = {
            "subject_ua": self.subject_ua,
            "relying_service": self.relying_service,
            "scopes": [{"domain": domain, "fields": fields, "access": "read"}],
            "purpose": reason,
            "ttl_seconds": 3600,
            "retention": "no-store",
            "sandbox": True,
        }
        if self.sandbox_persona:
            payload["sandbox_persona"] = self.sandbox_persona

        try:
            consent = await self.client.request_consent(payload)
        except httpx.HTTPStatusError as error:
            if error.response.status_code == 403 and "consent_declined" in error.response.text:
                self.execution_events.append(
                    {
                        "label": "Consent declined",
                        "actor": "Hussh Platform",
                        "status": "declined",
                        "detail": "The Hussh Platform declined the requested scope.",
                        "pchp_phase": "Consent",
                        "data": {"domain": domain, "fields": fields},
                    }
                )
                return None
            raise
        crt = consent["crt"]
        grant_id = consent["grant_id"]
        self.execution_events.append(
            {
                "label": "CRT issued",
                "actor": "Hussh Platform",
                "status": "approved",
                "detail": "The Hussh Platform minted a consent receipt token for the requested scope.",
                "pchp_phase": "Consent",
                "data": {"grant_id": grant_id, "domain": domain, "fields": fields},
            }
        )
        try:
            context_response = await self.client.get_context(crt)
        except httpx.HTTPStatusError as error:
            if error.response.status_code == 403 and "consent_revoked" in error.response.text:
                self.execution_events.append(
                    {
                        "label": "Consent revoked",
                        "actor": "Hussh Platform",
                        "status": "revoked",
                        "detail": "The Hussh Platform rejected context delivery because consent was revoked.",
                        "pchp_phase": "Revocation",
                        "data": {"domain": domain, "grant_id": grant_id},
                    }
                )
                raise ConsentRevokedError(domain)
            raise
        context = context_response.get("context", {}).get(domain)
        if context is None:
            return None
        self.execution_events.append(
            {
                "label": "SDK returns context",
                "actor": "Hussh SDK",
                "status": "returned",
                "detail": "agent.know() returns only the approved fields from the Hussh Platform.",
                "pchp_phase": "Context Delivery",
                "data": {"domain": domain, "context": context, "grant_id": grant_id},
            }
        )

        await self.client.acknowledge(
            grant_id=grant_id,
            effects=f"{self.relying_service} used {domain} context for: {reason}",
        )
        self.execution_events.append(
            {
                "label": "Usage acknowledged",
                "actor": "Hussh SDK",
                "status": "completed",
                "detail": "The SDK acknowledged successful context use with the Hussh Platform.",
                "pchp_phase": "Acknowledgment",
                "data": {"grant_id": grant_id, "retention": "no-store"},
            }
        )
        return context

    def _mock_know(self, domain: str, reason: str, fields: list[str]) -> dict | None:
        self.execution_events.append(
            {
                "label": f"agent.know({domain})",
                "actor": self.__class__.__name__,
                "status": "requested",
                "detail": "The generated agent asks the Hussh SDK for one declared scope.",
                "pchp_phase": "Offer",
                "data": {
                    "domain": domain,
                    "fields": fields,
                    "reason": reason,
                    "access": "read",
                    "ttl_seconds": 3600,
                    "retention": "no-store",
                },
            }
        )

        if self.mock_persona == "Priya":
            self.execution_events.extend(
                [
                    {
                        "label": "Priya declines",
                        "actor": "Nav",
                        "status": "declined",
                        "detail": "Priya declines the requested scope.",
                        "pchp_phase": "Nav Gate",
                        "data": {"decision": "declined", "domain": domain, "fields": fields},
                    },
                    {
                        "label": "SDK returns None",
                        "actor": "Hussh SDK",
                        "status": "returned",
                        "detail": "agent.know() returns None, so the generated fallback path runs.",
                        "pchp_phase": "Context Delivery",
                        "data": {"domain": domain, "value": None},
                    },
                ]
            )
            return None

        context = self._mock_context(domain=domain, fields=fields)
        self.execution_events.extend(
            [
                {
                    "label": f"{self.mock_persona} approves",
                    "actor": "Nav",
                    "status": "approved",
                    "detail": f"{self.mock_persona} approves the requested {domain} scope.",
                    "pchp_phase": "Nav Gate",
                    "data": {"decision": "approved", "domain": domain, "fields": fields},
                },
                {
                    "label": "SDK returns context",
                    "actor": "Hussh SDK",
                    "status": "returned",
                    "detail": "agent.know() returns only the approved fields for this scope.",
                    "pchp_phase": "Context Delivery",
                    "data": {
                        "domain": domain,
                        "context": context,
                        "crt": {
                            "grant_id": f"sandbox_{domain}_{self.mock_persona.lower()}",
                            "ttl_seconds": 3600,
                            "retention": "no-store",
                        },
                    },
                },
            ]
        )

        if self.mock_persona == "Reva":
            self.execution_events.append(
                {
                    "label": "Reva revokes",
                    "actor": "Nav",
                    "status": "revoked",
                    "detail": "Reva revokes consent during the run.",
                    "pchp_phase": "Revocation",
                    "data": {"domain": domain, "stop_access_within_seconds": 60},
                }
            )
            raise ConsentRevokedError(domain)

        return context

    def _mock_context(self, domain: str, fields: list[str]) -> dict:
        fixtures = {
            "calendar": {
                "upcoming_meetings": [
                    {
                        "title": "BYOK architecture review",
                        "time": "3:00 PM",
                        "attendees": ["Nirvana", "Priya"],
                        "agenda": [
                            "Show the Hussh One simulator",
                            "Explain Nav's consent boundary",
                            "Prove live BYOK runs without packaging keys",
                        ],
                    }
                ],
                "upcoming_events": [
                    {
                        "title": "BYOK architecture review",
                        "time": "3:00 PM",
                        "attendees": ["Nirvana", "Priya"],
                    }
                ],
                "meeting_times": ["3:00 PM"],
                "meeting_titles": ["BYOK architecture review"],
                "attendees": ["Nirvana", "Priya"],
            },
            "contacts": {
                "notes": {
                    "Priya": "Cares about privacy UX, consent language, and clear front-stage/backstage separation.",
                    "Nirvana": "Wants the demo to show real infrastructure value, not a narrow business app.",
                },
                "names": ["Priya", "Nirvana"],
                "roles": {"Priya": "Privacy reviewer", "Nirvana": "Builder"},
                "relationship_notes": {
                    "Priya": "Privacy UX and consent language",
                    "Nirvana": "Infrastructure value and demo clarity",
                },
                "recent_interactions": ["Architecture review prep"],
            },
            "preferences": {
                "communication_style": "direct, architectural, demo-oriented",
                "meeting_brief_format": "concise bullets with a suggested opener",
                "travel_style": "low-friction, privacy-conscious",
                "budget": "moderate",
                "accessibility": "step-free preferred",
            },
            "subscriptions": {
                "recurring": [
                    {
                        "name": "Figma",
                        "monthly_cost": 15,
                        "last_used_days_ago": 4,
                        "status": "keep",
                    },
                    {
                        "name": "Old analytics tool",
                        "monthly_cost": 79,
                        "last_used_days_ago": 96,
                        "status": "review",
                    },
                    {
                        "name": "Duplicate notes app",
                        "monthly_cost": 12,
                        "last_used_days_ago": 61,
                        "status": "cancel_candidate",
                    },
                ]
            },
        }
        domain_fixture = fixtures.get(domain, {})
        if not fields:
            return domain_fixture or {"summary": f"sandbox:{domain}.summary"}
        return {field: domain_fixture.get(field, f"sandbox:{domain}.{field}") for field in fields}


def runtime_config_for_mock(mock_mode: bool) -> RuntimeConfig:
    if mock_mode:
        return runtime_config("mock")
    return runtime_config("local_platform")
