# VaultDBService Migration Guide

## Overview

This document guides migration from the deprecated `VaultDBService` to `PersonalKnowledgeModelService` (PKM).

## Visual Map

```text
VaultDBService call sites
  -> adapter + deprecation warning
  -> PKMService scoped API migration
  -> route/service contract validation
  -> rollout + cleanup of legacy paths
```

**Status**: In Progress  
**Deadline**: Q3 2026  
**Migration Path**: Gradual, with deprecation warnings

---

## Why Migrate?

| Aspect | VaultDBService (Old) | PKMService (New) |
|--------|----------------------|------------------|
| Data Model | Flat vault table | Hierarchical PKM structure |
| Consent | Implicit | Explicit consent tokens |
| Audit | Limited | Full audit trail |
| Type Safety | Loose | Strong typing |
| Performance | Slower queries | Cached, indexed queries |
| Scopes | Not enforced | Enforced at service layer |

---

## Migration Steps

### Phase 1: Add Deprecation Warnings (Week 1-2)

```python
# consent-protocol/services/vault_db_service.py

import warnings
from functools import wraps

def deprecated(func):
    """Mark function as deprecated"""
    @wraps(func)
    def wrapper(*args, **kwargs):
        warnings.warn(
            f"{func.__name__} is deprecated. Use PersonalKnowledgeModelService instead.",
            DeprecationWarning,
            stacklevel=2
        )
        return func(*args, **kwargs)
    return wrapper

class VaultDBService:
    @deprecated
    def get_vault(self, vault_id: str) -> dict:
        # Implementation
        pass
    
    @deprecated
    def update_vault(self, vault_id: str, data: dict) -> None:
        # Implementation
        pass
```

### Phase 2: Create Migration Helpers (Week 3-4)

```python
# consent-protocol/services/migration_helpers.py

from consent_protocol.services.vault_db_service import VaultDBService
from consent_protocol.services.pkm_service import PersonalKnowledgeModelService

class VaultDBToPKMMigrator:
    """Helper to migrate VaultDBService calls to PKMService"""
    
    def __init__(self, vault_service: VaultDBService, pkm_service: PersonalKnowledgeModelService):
        self.vault_service = vault_service
        self.pkm_service = pkm_service
    
    def migrate_get_vault(self, vault_id: str, scopes: list) -> dict:
        """
        Replace: vault_service.get_vault(vault_id)
        With: pkm_service.get_vault(vault_id, scopes, consent_token)
        """
        # Map scopes to PKM paths
        pkm_paths = [f"pkm.{scope}" for scope in scopes]
        
        return self.pkm_service.get_vault(
            vault_id=vault_id,
            scopes=pkm_paths,
            consent_token=self.get_consent_token()
        )
    
    def migrate_update_vault(self, vault_id: str, data: dict, scopes: list) -> None:
        """
        Replace: vault_service.update_vault(vault_id, data)
        With: pkm_service.write_vault(vault_id, data, scopes, consent_token)
        """
        self.pkm_service.write_vault(
            vault_id=vault_id,
            data=data,
            scopes=scopes,
            consent_token=self.get_consent_token()
        )
    
    def migrate_list_vaults(self, user_id: str, scopes: list) -> list:
        """
        Replace: vault_service.list_vaults_for_user(user_id)
        With: pkm_service.list_vaults(user_id, scopes, consent_token)
        """
        return self.pkm_service.list_vaults(
            user_id=user_id,
            scopes=scopes,
            consent_token=self.get_consent_token()
        )
```

### Phase 3: Identify All VaultDBService Usage

```bash
# Find all references to VaultDBService
grep -r "VaultDBService" consent-protocol/ --include="*.py" | grep -v "__pycache__"

# Expected output (routes to update):
# consent-protocol/routes/vault.py: 12 references
# consent-protocol/routes/portfolio.py: 8 references
# consent-protocol/routes/agents/vault_agent.py: 5 references
# ...
```

### Phase 4: Migrate Routes One by One

#### Before: Using VaultDBService
```python
# consent-protocol/routes/vault.py

from consent_protocol.services.vault_db_service import VaultDBService

vault_service = VaultDBService(db)

@router.get("/vault/{vault_id}")
async def get_vault(vault_id: str, current_user: User = Depends(get_current_user)):
    """Old implementation"""
    vault = vault_service.get_vault(vault_id)
    
    if not vault:
        raise HTTPException(status_code=404)
    
    return vault
```

#### After: Using PKMService
```python
# consent-protocol/routes/vault.py

from consent_protocol.services.pkm_service import PersonalKnowledgeModelService

pkm_service = PersonalKnowledgeModelService(db)

@router.get("/vault/{vault_id}")
async def get_vault(
    vault_id: str,
    current_user: User = Depends(get_current_user),
    consent_token: str = Depends(get_consent_token),
):
    """New implementation with consent validation"""
    scopes = await extract_scopes_from_token(consent_token)
    
    # Validate consent before access
    if "vault.read" not in scopes:
        raise HTTPException(status_code=403, detail="Insufficient permissions")
    
    vault = await pkm_service.get_vault(
        vault_id=vault_id,
        scopes=scopes,
        consent_token=consent_token
    )
    
    if not vault:
        raise HTTPException(status_code=404)
    
    return vault
```

### Phase 5: Update Models and Schemas

#### VaultDBService Model
```python
# Old: Direct database table
class VaultDB(Base):
    __tablename__ = "vaults"
    
    id = Column(String(36), primary_key=True)
    user_id = Column(String(36), nullable=False)
    data = Column(Text, nullable=False)  # JSON blob
```

#### PKMService Model
```python
# New: Hierarchical structure
class VaultPKMEntry(Base):
    __tablename__ = "pkm_entries"
    
    id = Column(String(36), primary_key=True)
    user_id = Column(String(36), nullable=False)
    domain = Column(String(50), nullable=False)  # "vault", "portfolio", etc.
    path = Column(String(255), nullable=False)  # "vault.holdings", "vault.accounts"
    value = Column(Text, nullable=False)
    created_at = Column(DateTime, nullable=False)
    modified_at = Column(DateTime, nullable=False)
    consent_token_id = Column(String(36), ForeignKey("consent_tokens.id"))
```

### Phase 6: Dual-Write Pattern (Compatibility)

During transition, write to both systems:

```python
async def update_vault(vault_id: str, data: dict, consent_token: str):
    """Write to both old and new systems"""
    
    # Write to new PKMService
    await pkm_service.write_vault(vault_id, data, consent_token)
    
    # Write to old VaultDBService for backward compatibility
    vault_service.update_vault(vault_id, data)  # Deprecated call
```

### Phase 7: Cutover and Deprecation

Once all routes migrated:

1. **Set deprecation deadline** (e.g., December 2026)
2. **Stop accepting new VaultDBService calls**
3. **Log warnings for any remaining usage**
4. **Remove old tables in next major version**

---

## Migration Checklist

- [ ] **Routes Migrated**
  - [ ] `GET /vault/{id}` → PKMService
  - [ ] `POST /vault` → PKMService  
  - [ ] `PUT /vault/{id}` → PKMService
  - [ ] `DELETE /vault/{id}` → PKMService
  - [ ] `GET /portfolio/holdings` → PKMService
  - [ ] `POST /agents/vault_agent/query` → PKMService

- [ ] **Tests Updated**
  - [ ] Unit tests use PKMService mock
  - [ ] Integration tests use PKMService
  - [ ] E2E tests verify consent enforcement

- [ ] **Documentation**
  - [ ] API docs updated
  - [ ] Architecture docs updated
  - [ ] Migration guide published

- [ ] **Data Migration**
  - [ ] Backup old vault data
  - [ ] Bulk migrate to PKM structure
  - [ ] Verify data integrity
  - [ ] Run sync validation

---

## Rollback Plan

If migration issues arise:

```python
# Disable PKM temporarily
USE_PKM_SERVICE = os.getenv("USE_PKM_SERVICE", "true") == "true"

async def get_vault(vault_id: str, ...):
    if USE_PKM_SERVICE:
        return await pkm_service.get_vault(vault_id, ...)
    else:
        return vault_service.get_vault(vault_id)  # Fallback
```

Set `USE_PKM_SERVICE=false` to rollback.

---

## Success Metrics

- ✅ 100% of routes migrated to PKMService
- ✅ All tests pass with PKMService
- ✅ Zero deprecation warnings in tests
- ✅ Consent enforcement working
- ✅ Audit trail complete
- ✅ Mobile parity maintained

---

## Timeline

| Phase | Timeline | Owner |
|-------|----------|-------|
| Phase 1: Deprecation warnings | Week 1-2 | @engineering |
| Phase 2: Migration helpers | Week 3-4 | @engineering |
| Phase 3: Identify usage | Week 5 | @devops |
| Phase 4: Route migration | Week 6-8 | @engineering |
| Phase 5: Model updates | Week 9 | @engineering |
| Phase 6: Dual-write | Week 10-11 | @engineering |
| Phase 7: Cutover | Week 12 | @devops |

---

## References

- [PersonalKnowledgeModelService implementation](../../consent-protocol/hushh_mcp/services/personal_knowledge_model_service.py)
- [Consent route contract](../../consent-protocol/api/routes/consent.py)
- [Architecture API contracts](../reference/architecture/api-contracts.md)
