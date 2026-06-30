"""
Feature Flags System

Enables safe feature rollouts with A/B testing, canary deployments,
and instant rollbacks. Integrates with LaunchDarkly or self-hosted solution.

Features:
- Gradual rollouts (percentage-based)
- Audience targeting (user, region, etc.)
- A/B testing capabilities
- Audit trail for all flag changes
"""

import hashlib
from dataclasses import dataclass, field
from datetime import datetime
from enum import Enum
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends
from sqlalchemy import JSON, Column, DateTime, String
from sqlalchemy.ext.declarative import declarative_base

Base = declarative_base()


class FlagStatus(str, Enum):
    """Feature flag status"""
    OFF = "off"
    ON = "on"
    ROLLING_OUT = "rolling_out"
    DEPRECATED = "deprecated"


@dataclass
class FeatureFlag:
    """Feature flag definition"""
    name: str
    description: str
    status: FlagStatus = FlagStatus.OFF
    enabled_percentage: int = 0  # 0-100%
    enabled_users: List[str] = field(default_factory=list)
    enabled_regions: List[str] = field(default_factory=list)
    created_at: datetime = field(default_factory=datetime.utcnow)
    created_by: str = ""
    updated_at: datetime = field(default_factory=datetime.utcnow)
    updated_by: str = ""
    rollout_plan: Optional[Dict[str, Any]] = None


class FeatureFlagDB(Base):
    """Database model for feature flags"""
    
    __tablename__ = "feature_flags"
    
    id = Column(String(36), primary_key=True)
    name = Column(String(100), nullable=False, unique=True, index=True)
    description = Column(String(500), nullable=False)
    status = Column(String(20), nullable=False, default=FlagStatus.OFF)
    enabled_percentage = Column(Column(String(500), nullable=False), nullable=False, default=0)
    enabled_users = Column(JSON, nullable=False, default=[])
    enabled_regions = Column(JSON, nullable=False, default=[])
    created_at = Column(DateTime, nullable=False, default=datetime.utcnow)
    created_by = Column(String(36), nullable=False)
    updated_at = Column(DateTime, nullable=False, default=datetime.utcnow)
    updated_by = Column(String(36), nullable=False)
    rollout_plan = Column(JSON, nullable=True)


class FeatureFlagService:
    """Service for managing feature flags"""
    
    def __init__(self, db, cache=None):
        self.db = db
        self.cache = cache
    
    def is_enabled(
        self,
        flag_name: str,
        user_id: Optional[str] = None,
        user_region: Optional[str] = None,
    ) -> bool:
        """Check if flag is enabled for user"""
        flag = self._get_flag(flag_name)
        if not flag:
            return False
        
        # Flag is completely off
        if flag.status == FlagStatus.OFF:
            return False
        
        # Flag is fully on
        if flag.status == FlagStatus.ON:
            return True
        
        # Rolling out: check percentage and targeting
        if flag.status == FlagStatus.ROLLING_OUT:
            # Check specific user enablement
            if user_id and user_id in flag.enabled_users:
                return True
            
            # Check regional targeting
            if user_region and user_region not in flag.enabled_regions:
                return False
            
            # Check percentage rollout
            if user_id:
                return self._is_user_in_percentage(flag_name, user_id, flag.enabled_percentage)
            
            return False
        
        return False
    
    def create_flag(
        self,
        name: str,
        description: str,
        created_by: str,
        status: FlagStatus = FlagStatus.OFF,
    ) -> FeatureFlag:
        """Create new feature flag"""
        import uuid
        
        flag = FeatureFlagDB(
            id=str(uuid.uuid4()),
            name=name,
            description=description,
            status=status,
            created_by=created_by,
            updated_by=created_by,
        )
        
        self.db.add(flag)
        self.db.commit()
        
        # Clear cache
        if self.cache:
            self.cache.delete(f"flag:{name}")
        
        return self._db_to_flag(flag)
    
    def update_flag(
        self,
        name: str,
        status: Optional[FlagStatus] = None,
        enabled_percentage: Optional[int] = None,
        enabled_users: Optional[List[str]] = None,
        enabled_regions: Optional[List[str]] = None,
        updated_by: Optional[str] = None,
    ) -> FeatureFlag:
        """Update feature flag"""
        flag = self.db.query(FeatureFlagDB).filter_by(name=name).first()
        if not flag:
            raise ValueError(f"Flag '{name}' not found")
        
        if status is not None:
            flag.status = status
        if enabled_percentage is not None:
            flag.enabled_percentage = max(0, min(100, enabled_percentage))
        if enabled_users is not None:
            flag.enabled_users = enabled_users
        if enabled_regions is not None:
            flag.enabled_regions = enabled_regions
        if updated_by:
            flag.updated_by = updated_by
        
        flag.updated_at = datetime.utcnow()
        self.db.commit()
        
        # Clear cache
        if self.cache:
            self.cache.delete(f"flag:{name}")
        
        return self._db_to_flag(flag)
    
    def rollout_flag(
        self,
        name: str,
        percentage: int,
        updated_by: str,
    ) -> None:
        """Start gradual rollout of flag"""
        if not 0 <= percentage <= 100:
            raise ValueError("Percentage must be 0-100")
        
        self.update_flag(
            name,
            status=FlagStatus.ROLLING_OUT,
            enabled_percentage=percentage,
            updated_by=updated_by,
        )
    
    def get_flag(self, name: str) -> Optional[FeatureFlag]:
        """Get flag by name"""
        return self._get_flag(name)
    
    def list_flags(self) -> List[FeatureFlag]:
        """List all flags"""
        flags = self.db.query(FeatureFlagDB).all()
        return [self._db_to_flag(f) for f in flags]
    
    def _get_flag(self, name: str) -> Optional[FeatureFlag]:
        """Get flag from cache or database"""
        if self.cache:
            cached = self.cache.get(f"flag:{name}")
            if cached:
                return cached
        
        flag = self.db.query(FeatureFlagDB).filter_by(name=name).first()
        if flag:
            flag_obj = self._db_to_flag(flag)
            if self.cache:
                self.cache.set(f"flag:{name}", flag_obj, ttl=300)
            return flag_obj
        
        return None
    
    def _db_to_flag(self, db_flag: FeatureFlagDB) -> FeatureFlag:
        """Convert DB model to domain object"""
        return FeatureFlag(
            name=db_flag.name,
            description=db_flag.description,
            status=FlagStatus(db_flag.status),
            enabled_percentage=db_flag.enabled_percentage,
            enabled_users=db_flag.enabled_users or [],
            enabled_regions=db_flag.enabled_regions or [],
            created_at=db_flag.created_at,
            created_by=db_flag.created_by,
            updated_at=db_flag.updated_at,
            updated_by=db_flag.updated_by,
        )
    
    def _is_user_in_percentage(self, flag_name: str, user_id: str, percentage: int) -> bool:
        """Deterministically check if user is in percentage"""

        # Create a stable hash for user + flag combination
        hash_input = f"{flag_name}:{user_id}".encode()
        hash_value = int(hashlib.sha256(hash_input).hexdigest(), 16)
        
        # Map to 0-100
        user_percentage = (hash_value % 100) + 1
        
        return user_percentage <= percentage


router = APIRouter(prefix="/flags", tags=["flags"])


@router.get("/{flag_name}")
async def check_flag(
    flag_name: str,
    user_id: Optional[str] = None,
    user_region: Optional[str] = None,
    flag_service: FeatureFlagService = Depends(),
) -> dict:
    """Check if flag is enabled for user"""
    is_enabled = flag_service.is_enabled(
        flag_name,
        user_id=user_id,
        user_region=user_region,
    )
    
    return {
        "flag": flag_name,
        "enabled": is_enabled,
    }


@router.get("/")
async def list_flags(
    flag_service: FeatureFlagService = Depends(),
) -> dict:
    """List all flags"""
    flags = flag_service.list_flags()
    
    return {
        "flags": [
            {
                "name": f.name,
                "description": f.description,
                "status": f.status,
                "enabled_percentage": f.enabled_percentage,
            }
            for f in flags
        ]
    }


# React Hook for client-side feature flag checking
"""
import { useState, useEffect } from 'react';

export function useFeatureFlag(flagName: string, userId?: string, region?: string): boolean {
  const [enabled, setEnabled] = useState(false);

  useEffect(() => {
    fetch(`/api/flags/${flagName}`, {
      params: { user_id: userId, user_region: region }
    })
      .then(res => res.json())
      .then(data => setEnabled(data.enabled));
  }, [flagName, userId, region]);

  return enabled;
}

// Usage
export function PortfolioAnalytics() {
  const isNewDashboardEnabled = useFeatureFlag('portfolio-analytics-v2', userId);

  return (
    <>
      {isNewDashboardEnabled ? (
        <NewAnalyticsDashboard />
      ) : (
        <OldAnalyticsDashboard />
      )}
    </>
  );
}
"""

# Example flag configurations
FLAGS = {
    "voice-agent-realtime": {
        "description": "Enable OpenAI real-time API for voice agent",
        "rollout_plan": {
            "week_1": 5,    # 5% of users
            "week_2": 10,
            "week_3": 25,
            "week_4": 50,
            "week_5": 100,
        }
    },
    "indian-market-support": {
        "description": "Enable NSE/BSE stock market support",
        "rollout_plan": {
            "beta": ["user_123", "user_456"],  # Specific users
            "regions": ["IN"],  # India only
        }
    },
    "analytics-v2": {
        "description": "New analytics dashboard",
        "rollout_plan": {
            "initial": 0,
            "target": 100,
        }
    },
}
