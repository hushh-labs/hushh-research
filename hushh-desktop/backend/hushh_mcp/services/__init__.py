# hushh_mcp/services/__init__.py
"""
Service Layer
=============

Unified service layer for agent-mediated database access.
All database operations should go through these services.

CONSENT-FIRST ARCHITECTURE:
    All services validate consent tokens before database access.
    API routes should use these services, never access database directly.
"""

from .consent_db import ConsentDBService
from .investor_db import InvestorDBService
from .vault_db import VaultDBService
from .vault_keys_service import VaultKeysService

__all__ = [
    "VaultDBService",
    "ConsentDBService",
    "InvestorDBService",
    "VaultKeysService",
]
