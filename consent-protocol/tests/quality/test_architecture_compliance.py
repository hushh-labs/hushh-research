"""
Architecture Compliance Tests - RUN ON EVERY PR

These tests scan the codebase for violations of consent-first patterns.
Failing these tests will BLOCK the PR from merging.

CRITICAL: These tests enforce our core architecture rules:
1. API routes must use service layer (not direct Supabase)
2. All vault operations must validate consent tokens
3. No backdoors or bypasses allowed
4. PKM scopes only: attr.{domain}.* and pkm.read/write
5. PKM service must be used for new data storage
"""

import os
import shutil
import subprocess

import pytest


class TestServiceLayerCompliance:
    """Ensure API routes never access Supabase directly."""

    @pytest.fixture(autouse=True)
    def setup(self):
        """Set working directory to consent-protocol root."""
        self.cwd = os.path.dirname(os.path.dirname(os.path.dirname(__file__)))

    def test_no_direct_supabase_in_routes(self):
        """API routes must use service layer, not get_db() or get_supabase()."""
        grep_path = shutil.which("grep")
        assert grep_path, "grep not found on PATH"
        result = subprocess.run(  # noqa: S603
            [grep_path, "-rE", "get_supabase\\(\\)|get_db\\(\\)", "api/routes/"],
            capture_output=True,
            text=True,
            cwd=self.cwd,
        )
        violations = result.stdout.strip()

        assert not violations, f"""
❌ CONSENT VIOLATION: Direct database access in API routes!

API routes must use service layer classes, not get_db() or get_supabase() directly.

WRONG:
    from db.db_client import get_db
    db = get_db()
    data = db.table('vault_food').select('*').execute()

CORRECT:
    from hushh_mcp.services import VaultDBService
    service = VaultDBService()
    data = await service.get_encrypted_fields(
        user_id=user_id,
        domain="food",
        consent_token=consent_token  # Required!
    )

See: docs/reference/database_service_layer.md

Violations found:
{violations}
"""

    def test_no_direct_db_import_in_routes(self):
        """API routes must not import db.db_client or db.supabase_client directly."""
        grep_path = shutil.which("grep")
        assert grep_path, "grep not found on PATH"
        result = subprocess.run(  # noqa: S603
            [
                grep_path,
                "-rE",
                r"from db\.(supabase_client|db_client|connection) import",
                "api/routes/",
            ],
            capture_output=True,
            text=True,
            cwd=self.cwd,
        )
        violations = result.stdout.strip()

        assert not violations, f"""
❌ FORBIDDEN IMPORT: Direct database import in API routes!

API routes must import services, not database clients.

WRONG:
    from db.supabase_client import get_supabase

CORRECT:
    from hushh_mcp.services import VaultDBService

Violations found:
{violations}
"""


class TestConsentPatternCompliance:
    """Ensure consent patterns are followed."""

    @pytest.fixture(autouse=True)
    def setup(self):
        """Set working directory to consent-protocol root."""
        self.cwd = os.path.dirname(os.path.dirname(os.path.dirname(__file__)))

    def test_service_files_exist(self):
        """All required service files must exist."""
        required_services = [
            "hushh_mcp/services/vault_db.py",
            "hushh_mcp/services/consent_db.py",
            "hushh_mcp/services/investor_db.py",
            "hushh_mcp/services/vault_keys_service.py",
            "hushh_mcp/services/personal_knowledge_model_service.py",
            "hushh_mcp/services/domain_registry_service.py",
            "hushh_mcp/services/attribute_learner.py",
            "hushh_mcp/consent/scope_generator.py",
        ]

        for service in required_services:
            path = os.path.join(self.cwd, service)
            assert os.path.exists(path), f"""
❌ MISSING SERVICE: {service}

This service file is required for architecture compliance.
"""


class TestDynamicScopeCompliance:
    """Ensure PKM scopes (attr.{domain}.*, pkm.read/write) are used."""

    @pytest.fixture(autouse=True)
    def setup(self):
        """Set working directory to consent-protocol root."""
        self.cwd = os.path.dirname(os.path.dirname(os.path.dirname(__file__)))

    def test_scope_generator_exists(self):
        """DynamicScopeGenerator must exist for dynamic scope validation."""
        path = os.path.join(self.cwd, "hushh_mcp/consent/scope_generator.py")
        assert os.path.exists(path), """
❌ MISSING: DynamicScopeGenerator

The scope_generator.py file is required for dynamic attr.{domain}.* scope validation.
"""

    def test_domain_registry_exists(self):
        """DomainRegistryService must exist for dynamic domain discovery."""
        path = os.path.join(self.cwd, "hushh_mcp/services/domain_registry_service.py")
        assert os.path.exists(path), """
❌ MISSING: DomainRegistryService

The domain_registry_service.py file is required for dynamic domain discovery.
"""

    def test_pkm_service_exists(self):
        """PersonalKnowledgeModelService must exist for unified data storage."""
        path = os.path.join(self.cwd, "hushh_mcp/services/personal_knowledge_model_service.py")
        assert os.path.exists(path), """
❌ MISSING: PersonalKnowledgeModelService

The personal_knowledge_model_service.py file is required for unified data storage.
All new data should be stored through the PKM service via encrypted domain payloads.
"""

    def test_constants_has_dynamic_scope_support(self):
        """ConsentScope enum must support dynamic scope validation."""
        from hushh_mcp.constants import ConsentScope

        # Check that is_dynamic_scope method exists
        assert hasattr(ConsentScope, "is_dynamic_scope"), """
❌ MISSING: ConsentScope.is_dynamic_scope()

The ConsentScope enum must have is_dynamic_scope() method for validating attr.{domain}.* scopes.
"""

        # Test dynamic scope detection
        assert ConsentScope.is_dynamic_scope("attr.food.dietary_restrictions"), """
❌ FAILED: ConsentScope.is_dynamic_scope() should return True for attr.* scopes
"""

        assert not ConsentScope.is_dynamic_scope("vault.owner"), """
❌ FAILED: ConsentScope.is_dynamic_scope() should return False for non-attr.* scopes
"""

    def test_scope_generator_generates_valid_scopes(self):
        """DynamicScopeGenerator must generate valid attr.{domain}.{key} scopes."""
        from hushh_mcp.consent.scope_generator import get_scope_generator

        generator = get_scope_generator()

        # Test scope generation
        scope = generator.generate_scope("food", "dietary_restrictions")
        assert scope == "attr.food.dietary_restrictions", f"""
❌ FAILED: Scope generation incorrect

Expected: attr.food.dietary_restrictions
Got: {scope}
"""

        # Test wildcard generation
        wildcard = generator.generate_domain_wildcard("financial")
        assert wildcard == "attr.financial.*", f"""
❌ FAILED: Wildcard scope generation incorrect

Expected: attr.financial.*
Got: {wildcard}
"""

    def test_scope_generator_parses_scopes(self):
        """DynamicScopeGenerator must correctly parse scope strings."""
        from hushh_mcp.consent.scope_generator import get_scope_generator

        generator = get_scope_generator()

        # Test specific scope parsing
        domain, key, is_wildcard = generator.parse_scope("attr.food.dietary_restrictions")
        assert domain == "food", f"Expected domain 'food', got '{domain}'"
        assert key == "dietary_restrictions", f"Expected key 'dietary_restrictions', got '{key}'"
        assert not is_wildcard, "Expected is_wildcard=False"

        # Test wildcard scope parsing
        domain, key, is_wildcard = generator.parse_scope("attr.financial.*")
        assert domain == "financial", f"Expected domain 'financial', got '{domain}'"
        assert key is None, f"Expected key None, got '{key}'"
        assert is_wildcard, "Expected is_wildcard=True"

    def test_scope_generator_matches_wildcards(self):
        """DynamicScopeGenerator must correctly match wildcard patterns."""
        from hushh_mcp.consent.scope_generator import get_scope_generator

        generator = get_scope_generator()

        # Test wildcard matching
        assert generator.matches_wildcard("attr.food.dietary_restrictions", "attr.food.*"), """
❌ FAILED: Wildcard matching should return True for attr.food.dietary_restrictions matching attr.food.*
"""

        assert not generator.matches_wildcard("attr.professional.title", "attr.food.*"), """
❌ FAILED: Wildcard matching should return False for attr.professional.title matching attr.food.*
"""


class TestAttributeLearnerCompliance:
    """Ensure attribute learner follows BYOK and consent patterns."""

    @pytest.fixture(autouse=True)
    def setup(self):
        """Set working directory to consent-protocol root."""
        self.cwd = os.path.dirname(os.path.dirname(os.path.dirname(__file__)))

    def test_attribute_learner_exists(self):
        """AttributeLearner must exist for auto-learning user preferences."""
        path = os.path.join(self.cwd, "hushh_mcp/services/attribute_learner.py")
        assert os.path.exists(path), """
❌ MISSING: AttributeLearner

The attribute_learner.py file is required for auto-learning user preferences from conversation.
"""

    def test_domain_inferrer_not_in_canonical_runtime_path(self):
        """Canonical PKM runtime must not depend on the legacy domain inferrer."""
        service_path = os.path.join(
            self.cwd, "hushh_mcp/services/personal_knowledge_model_service.py"
        )
        with open(service_path, encoding="utf-8") as handle:
            content = handle.read()
        assert "domain_inferrer" not in content, """
❌ LEGACY SEMANTIC DRIFT: PersonalKnowledgeModelService still references domain_inferrer.

The canonical PKM runtime path must derive semantics through agents, not the legacy rule engine.
"""


class TestHardcodedDomainCompliance:
    """Ensure no hardcoded domain strings exist outside allowed locations."""

    @pytest.fixture(autouse=True)
    def setup(self):
        """Set working directory to consent-protocol root."""
        self.cwd = os.path.dirname(os.path.dirname(os.path.dirname(__file__)))

    def test_no_hardcoded_domains_in_api_routes(self):
        """
        API routes must not contain hardcoded domain checks.

        Allowed patterns:
        - DEFAULT_DOMAIN_METADATA in domain_registry_service.py
        - Example/documentation in tests

        Forbidden patterns:
        - if domain == "food" / "professional" / "financial" / "health"
        - domain in ["food", "professional", ...]
        - Hardcoded domain lists/dicts in routes
        """
        grep_path = shutil.which("grep")
        assert grep_path, "grep not found on PATH"

        # Search for hardcoded domain string literals in API routes
        result = subprocess.run(  # noqa: S603
            [
                grep_path,
                "-rE",
                r'(domain\s*==\s*["\'])(food|professional|financial|health)(["\'])',
                "api/routes/",
                "--exclude=pkm_routes_shared.py",
            ],
            capture_output=True,
            text=True,
            cwd=self.cwd,
        )
        violations = result.stdout.strip()

        assert not violations, f"""
❌ HARDCODED DOMAIN VIOLATION: Found hardcoded domain checks in API routes!

API routes must use dynamic domain lookup from domain_registry, not hardcoded domain strings.

WRONG:
    if domain == "food":
        # ...
    
CORRECT:
    from hushh_mcp.services.domain_registry_service import get_domain_registry_service
    registry = get_domain_registry_service()
    domain_info = await registry.get_domain(domain)

Violations found:
{violations}
"""

    def test_no_hardcoded_domain_lists_in_routes(self):
        """API routes must not have hardcoded lists of domains."""
        grep_path = shutil.which("grep")
        assert grep_path, "grep not found on PATH"

        # Search for lists like ["food", "professional", ...]
        result = subprocess.run(  # noqa: S603
            [
                grep_path,
                "-rE",
                r'\["food",\s*"professional"',
                "api/routes/",
                "--exclude=pkm_routes_shared.py",
            ],
            capture_output=True,
            text=True,
            cwd=self.cwd,
        )
        violations = result.stdout.strip()

        assert not violations, f"""
❌ HARDCODED DOMAIN LIST VIOLATION: Found hardcoded domain lists in API routes!

Use domain_registry.list_domains() instead of hardcoded lists.

WRONG:
    DOMAINS = ["food", "professional", "financial", "health"]
    
CORRECT:
    domains = await domain_registry.list_domains()

Violations found:
{violations}
"""

    def test_scope_helpers_imported_where_needed(self):
        """Files that resolve scopes must import scope_helpers, not hardcode maps."""
        grep_path = shutil.which("grep")
        assert grep_path, "grep not found on PATH"

        # Files that have SCOPE_TO_ENUM or SCOPE_ENUM_MAP must import scope_helpers
        result = subprocess.run(  # noqa: S603
            [
                grep_path,
                "-rl",
                r"SCOPE_TO_ENUM\s*=\s*{",
                "api/",
                "mcp_modules/",
            ],
            capture_output=True,
            text=True,
            cwd=self.cwd,
        )

        if result.stdout.strip():
            raise AssertionError(
                "❌ HARDCODED SCOPE MAP VIOLATION: Found SCOPE_TO_ENUM dictionaries!\n\n"
                "Use resolve_scope_to_enum() from scope_helpers instead.\n\n"
                f"Files with violations:\n{result.stdout}\n\n"
                "WRONG:\n"
                "    SCOPE_TO_ENUM = {\n"
                "        'attr.food.*': ConsentScope.PKM_READ,\n"
                "        ...\n"
                "    }\n"
                "    scope = SCOPE_TO_ENUM.get(scope_str)\n\n"
                "CORRECT:\n"
                "    from hushh_mcp.consent.scope_helpers import resolve_scope_to_enum\n"
                "    scope = resolve_scope_to_enum(scope_str)\n"
            )


class TestPkmMigrationCompliance:
    """Ensure PKM storage is used instead of legacy vault_* tables for new code."""

    @pytest.fixture(autouse=True)
    def setup(self):
        """Set working directory to consent-protocol root."""
        self.cwd = os.path.dirname(os.path.dirname(os.path.dirname(__file__)))

    def test_pkm_service_exists(self):
        """PersonalKnowledgeModelService must exist as preferred data storage."""
        path = os.path.join(self.cwd, "hushh_mcp/services/personal_knowledge_model_service.py")
        assert os.path.exists(path), """
❌ MISSING: PersonalKnowledgeModelService

The personal_knowledge_model_service.py file is required for dynamic data storage.
"""

    def test_vault_db_has_deprecation_notice(self):
        """VaultDBService must have deprecation notice pointing to PersonalKnowledgeModelService."""
        vault_db_path = os.path.join(self.cwd, "hushh_mcp/services/vault_db.py")

        with open(vault_db_path, "r") as f:
            content = f.read()

        assert "DEPRECATION" in content or "deprecated" in content.lower(), """
❌ MISSING DEPRECATION NOTICE: vault_db.py must indicate it's deprecated!

Add a deprecation notice in the docstring pointing developers to PersonalKnowledgeModelService.
"""

        assert "PersonalKnowledgeModelService" in content, """
❌ INCOMPLETE DEPRECATION NOTICE: Must reference PersonalKnowledgeModelService as replacement!

The deprecation notice should guide developers to use PersonalKnowledgeModelService instead.
"""
