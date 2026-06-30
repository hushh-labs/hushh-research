"""
Consent Token Rotation Service

Implements automatic consent token rotation after 90 days to reduce
compromise risk. Tokens are rotated on a sliding window schedule with
backward compatibility during transition periods.

Strategy:
1. Original token remains valid for 30 days after rotation
2. New token issued automatically 90 days after creation
3. Client-side auto-refresh before expiry
4. Server validates both old and new tokens during transition
"""

import datetime
import hashlib
import logging
import secrets
import uuid
from dataclasses import dataclass
from enum import Enum
from typing import Optional, Tuple

from apscheduler.schedulers.background import BackgroundScheduler
from fastapi import APIRouter, Depends, Header, HTTPException
from sqlalchemy import Column, DateTime, ForeignKey, Integer, String
from sqlalchemy.orm import Session, declarative_base, relationship

logger = logging.getLogger(__name__)

Base = declarative_base()


class TokenStatus(str, Enum):
    """Token lifecycle status"""

    ACTIVE = "active"
    ROTATING = "rotating"  # Old token still accepted
    EXPIRED = "expired"
    REVOKED = "revoked"


@dataclass
class ConsentTokenMetadata:
    """Metadata for consent token"""

    user_id: str
    scopes: list
    created_at: datetime.datetime
    expires_at: datetime.datetime
    rotation_scheduled_at: Optional[datetime.datetime] = None
    status: TokenStatus = TokenStatus.ACTIVE
    version: int = 1  # Token rotation version


class ConsentTokenDB(Base):
    """Database model for consent tokens"""

    __tablename__ = "consent_tokens"

    id = Column(String(36), primary_key=True)  # UUID
    user_id = Column(String(36), ForeignKey("users.id"), nullable=False, index=True)
    token_hash = Column(String(64), nullable=False, unique=True, index=True)  # SHA256
    scopes = Column(String(255), nullable=False)  # JSON serialized
    created_at = Column(DateTime, nullable=False, default=datetime.datetime.utcnow)
    expires_at = Column(DateTime, nullable=False)  # Initial expiry
    rotation_scheduled_at = Column(DateTime, nullable=True)  # When new token issued
    new_token_id = Column(String(36), nullable=True)  # Reference to rotated token
    status = Column(String(20), nullable=False, default=TokenStatus.ACTIVE)
    version = Column(Integer, nullable=False, default=1)
    last_used_at = Column(DateTime, nullable=True)
    ip_address = Column(String(45), nullable=True)  # IPv4 or IPv6
    user_agent = Column(String(255), nullable=True)

    # Relationship to next token in rotation chain
    rotated_token = relationship(
        "ConsentTokenDB",
        remote_side=[id],
        uselist=False,
        foreign_keys=[new_token_id],
    )


# ---------------------------------------------------------------------------
# Dependency placeholders – replace with your project's actual implementations
# ---------------------------------------------------------------------------


def get_db() -> Session:  # pragma: no cover
    """Yield a database session. Override with your actual session factory."""
    raise NotImplementedError("Provide a real get_db dependency")


def get_current_user_id() -> str:  # pragma: no cover
    """Extract the authenticated user's ID from the request. Override as needed."""
    raise NotImplementedError("Provide a real get_current_user_id dependency")


def extract_token_from_request() -> str:  # pragma: no cover
    """Extract the bearer token from the current request. Override as needed."""
    raise NotImplementedError("Provide a real extract_token_from_request helper")


# ---------------------------------------------------------------------------
# Service
# ---------------------------------------------------------------------------


class ConsentTokenService:
    """Service for managing consent token lifecycle and rotation"""

    # Configuration
    TOKEN_LIFETIME = 90 * 24 * 60 * 60  # 90 days in seconds
    ROTATION_WINDOW = 30 * 24 * 60 * 60  # 30 days: old token still accepted after rotation
    TOKEN_LENGTH = 32  # 256-bit token

    def __init__(self, db_session: Session):
        self.db = db_session

    def create_token(
        self,
        user_id: str,
        scopes: list,
        ip_address: Optional[str] = None,
        user_agent: Optional[str] = None,
    ) -> Tuple[str, ConsentTokenMetadata]:
        """
        Create a new consent token

        Returns:
            Tuple of (token, metadata)
        """
        token_id = str(uuid.uuid4())
        token = self._generate_token()
        token_hash = self._hash_token(token)

        now = datetime.datetime.utcnow()
        expires_at = now + datetime.timedelta(seconds=self.TOKEN_LIFETIME)
        rotation_scheduled_at = now + datetime.timedelta(
            seconds=self.TOKEN_LIFETIME - self.ROTATION_WINDOW
        )

        db_token = ConsentTokenDB(
            id=token_id,
            user_id=user_id,
            token_hash=token_hash,
            scopes=",".join(scopes),
            created_at=now,
            expires_at=expires_at,
            rotation_scheduled_at=rotation_scheduled_at,
            status=TokenStatus.ACTIVE,
            version=1,
            ip_address=ip_address,
            user_agent=user_agent,
        )

        self.db.add(db_token)
        self.db.commit()

        metadata = ConsentTokenMetadata(
            user_id=user_id,
            scopes=scopes,
            created_at=now,
            expires_at=expires_at,
            rotation_scheduled_at=rotation_scheduled_at,
            status=TokenStatus.ACTIVE,
            version=1,
        )

        return token, metadata

    def rotate_token(
        self,
        old_token: str,
        user_id: str,
    ) -> Tuple[str, ConsentTokenMetadata]:
        """
        Rotate an existing consent token

        Creates new token and marks old token for grace period.

        Returns:
            Tuple of (new_token, metadata)
        """
        old_token_db = self._get_token_by_value(old_token)
        if not old_token_db:
            raise ValueError("Invalid token")

        if old_token_db.user_id != user_id:
            raise ValueError("Token does not belong to user")

        new_token_id = str(uuid.uuid4())
        new_token = self._generate_token()
        new_token_hash = self._hash_token(new_token)

        now = datetime.datetime.utcnow()
        expires_at = now + datetime.timedelta(seconds=self.TOKEN_LIFETIME)
        rotation_scheduled_at = now + datetime.timedelta(
            seconds=self.TOKEN_LIFETIME - self.ROTATION_WINDOW
        )

        scopes = old_token_db.scopes.split(",")

        new_token_db = ConsentTokenDB(
            id=new_token_id,
            user_id=user_id,
            token_hash=new_token_hash,
            scopes=old_token_db.scopes,
            created_at=now,
            expires_at=expires_at,
            rotation_scheduled_at=rotation_scheduled_at,
            status=TokenStatus.ACTIVE,
            version=old_token_db.version + 1,
            ip_address=old_token_db.ip_address,
            user_agent=old_token_db.user_agent,
        )

        old_token_db.status = TokenStatus.ROTATING
        old_token_db.new_token_id = new_token_id
        old_token_db.rotation_scheduled_at = now

        self.db.add(new_token_db)
        self.db.commit()

        metadata = ConsentTokenMetadata(
            user_id=user_id,
            scopes=scopes,
            created_at=now,
            expires_at=expires_at,
            rotation_scheduled_at=rotation_scheduled_at,
            status=TokenStatus.ACTIVE,
            version=new_token_db.version,
        )

        return new_token, metadata

    def verify_token(self, token: str, user_id: str) -> bool:
        """
        Verify if token is valid for user

        Accepts both current and recently-rotated tokens during grace period.
        """
        token_db = self._get_token_by_value(token)
        if not token_db:
            return False

        if token_db.user_id != user_id:
            return False

        now = datetime.datetime.utcnow()

        if now > token_db.expires_at:
            return False

        if token_db.status == TokenStatus.REVOKED:
            return False

        if token_db.status == TokenStatus.ROTATING:
            grace_period = datetime.timedelta(seconds=self.ROTATION_WINDOW)
            rotation_time = token_db.rotation_scheduled_at
            if now > rotation_time + grace_period:
                return False

        token_db.last_used_at = now
        self.db.commit()

        return True

    def get_token_metadata(self, token: str) -> Optional[ConsentTokenMetadata]:
        """Get metadata for token"""
        token_db = self._get_token_by_value(token)
        if not token_db:
            return None

        return ConsentTokenMetadata(
            user_id=token_db.user_id,
            scopes=token_db.scopes.split(","),
            created_at=token_db.created_at,
            expires_at=token_db.expires_at,
            rotation_scheduled_at=token_db.rotation_scheduled_at,
            status=TokenStatus(token_db.status),
            version=token_db.version,
        )

    def should_rotate(self, token: str) -> bool:
        """Check if token should be rotated soon"""
        token_db = self._get_token_by_value(token)
        if not token_db:
            return False

        now = datetime.datetime.utcnow()
        return bool(token_db.rotation_scheduled_at and now >= token_db.rotation_scheduled_at)

    def revoke_token(self, token: str, user_id: str) -> bool:
        """
        Revoke a consent token (immediate invalidation)
        """
        token_db = self._get_token_by_value(token)
        if not token_db:
            return False

        if token_db.user_id != user_id:
            return False

        token_db.status = TokenStatus.REVOKED
        self.db.commit()

        return True

    def cleanup_expired_tokens(self) -> int:
        """
        Clean up expired tokens (run periodically via scheduled task)

        Returns:
            Number of tokens deleted
        """
        now = datetime.datetime.utcnow()
        grace_period = now - datetime.timedelta(seconds=self.ROTATION_WINDOW)

        deleted_count = (
            self.db.query(ConsentTokenDB)
            .filter(ConsentTokenDB.expires_at < grace_period)
            .delete()
        )

        self.db.commit()

        return deleted_count

    def _get_token_by_value(self, token: str) -> Optional[ConsentTokenDB]:
        """Get token from database by value"""
        token_hash = self._hash_token(token)
        return (
            self.db.query(ConsentTokenDB)
            .filter(ConsentTokenDB.token_hash == token_hash)
            .first()
        )

    def _generate_token(self) -> str:
        """Generate a cryptographically secure random token"""
        return secrets.token_urlsafe(self.TOKEN_LENGTH)

    def _hash_token(self, token: str) -> str:
        """Hash token for storage (never store plaintext)"""
        return hashlib.sha256(token.encode()).hexdigest()


# ---------------------------------------------------------------------------
# FastAPI router
# ---------------------------------------------------------------------------

router = APIRouter(prefix="/consent", tags=["consent"])


@router.post("/tokens/rotate")
async def rotate_consent_token(
    current_user_id: str = Depends(get_current_user_id),
    db: Session = Depends(get_db),
    user_agent: Optional[str] = Header(None),
    x_forwarded_for: Optional[str] = Header(None),  # noqa: ARG001
) -> dict:
    """
    Rotate the user's consent token

    Returns new token with extended validity period.
    Old token remains valid for 30 days (grace period).
    """
    service = ConsentTokenService(db)
    current_token = extract_token_from_request()

    try:
        new_token, metadata = service.rotate_token(current_token, current_user_id)
        return {
            "token": new_token,
            "expires_at": metadata.expires_at.isoformat(),
            "rotation_scheduled_at": (
                metadata.rotation_scheduled_at.isoformat()
                if metadata.rotation_scheduled_at
                else None
            ),
        }
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e


@router.get("/tokens/should-rotate")
async def check_rotation_needed(
    current_user_id: str = Depends(get_current_user_id),
    db: Session = Depends(get_db),
) -> dict:
    """
    Check if token should be rotated

    Client calls this periodically to determine if rotation needed.
    """
    current_token = extract_token_from_request()

    service = ConsentTokenService(db)
    should_rotate = service.should_rotate(current_token)
    token_metadata = service.get_token_metadata(current_token)

    return {
        "should_rotate": should_rotate,
        "expires_at": token_metadata.expires_at.isoformat() if token_metadata else None,
        "rotation_scheduled_at": (
            token_metadata.rotation_scheduled_at.isoformat()
            if token_metadata and token_metadata.rotation_scheduled_at
            else None
        ),
    }


@router.post("/tokens/revoke")
async def revoke_token(
    current_user_id: str = Depends(get_current_user_id),
    db: Session = Depends(get_db),
) -> dict:
    """
    Revoke the current consent token (immediate invalidation)

    Use when token is compromised or user wants to force re-auth.
    """
    current_token = extract_token_from_request()

    service = ConsentTokenService(db)
    revoked = service.revoke_token(current_token, current_user_id)

    if not revoked:
        raise HTTPException(status_code=400, detail="Failed to revoke token")

    return {"status": "revoked"}


# ---------------------------------------------------------------------------
# Scheduled cleanup – run daily at 2 AM UTC
# APScheduler does NOT use FastAPI's Depends system.
# Provide your own session factory here.
# ---------------------------------------------------------------------------


def _make_cleanup_db_session() -> Session:  # pragma: no cover
    """
    Create a standalone DB session for the scheduler job.
    Replace with your actual session factory, e.g.::

        from your_app.database import SessionLocal
        return SessionLocal()
    """
    raise NotImplementedError("Configure _make_cleanup_db_session with your SessionLocal")


scheduler = BackgroundScheduler()


@scheduler.scheduled_job("cron", hour=2, minute=0)
def cleanup_expired_tokens_job() -> None:
    """Clean up expired tokens daily at 2 AM UTC"""
    db = _make_cleanup_db_session()
    try:
        service = ConsentTokenService(db)
        deleted_count = service.cleanup_expired_tokens()
        logger.info("Cleaned up %d expired tokens", deleted_count)
    finally:
        db.close()


scheduler.start()
