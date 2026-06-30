"""
Result<T, E> Type Pattern

Replaces exceptions with explicit Result type for better error handling,
composability, and type safety. Inspired by Rust and functional programming.

Usage:
    from result import Result, Ok, Err
    
    def get_vault(vault_id: str) -> Result[Vault, VaultError]:
        vault = db.query(Vault).filter_by(id=vault_id).first()
        if vault:
            return Ok(vault)
        return Err(VaultNotFoundError(f"Vault {vault_id} not found"))
    
    # Caller
    result = get_vault("123")
    if result.is_ok():
        vault = result.unwrap()
    else:
        error = result.unwrap_err()
        logger.error(f"Failed: {error}")
"""

from dataclasses import dataclass
from typing import Callable, Generic, TypeVar, Union

from fastapi import APIRouter, Depends, Request
from fastapi.responses import JSONResponse
from starlette.middleware.base import BaseHTTPMiddleware

T = TypeVar('T')
E = TypeVar('E')
U = TypeVar('U')


class ResultError(Exception):
    """Base class for all service errors"""
    def __init__(self, message: str, code: str = "UNKNOWN_ERROR"):
        self.message = message
        self.code = code
        super().__init__(message)
    
    def __repr__(self) -> str:
        return f"{self.__class__.__name__}(code={self.code}, message={self.message})"


class VaultError(ResultError):
    """Vault service errors"""
    pass


class ConsentError(ResultError):
    """Consent service errors"""
    pass


class PKMError(ResultError):
    """Personal Knowledge Model service errors"""
    pass


class ValidationError(ResultError):
    """Data validation errors"""
    pass


class NotFoundError(ResultError):
    """Resource not found errors"""
    def __init__(self, resource: str, identifier: str):
        message = f"{resource} not found: {identifier}"
        super().__init__(message, code="NOT_FOUND")


class UnauthorizedError(ResultError):
    """Authorization errors"""
    def __init__(self, message: str = "Unauthorized"):
        super().__init__(message, code="UNAUTHORIZED")


@dataclass
class Result(Generic[T, E]):
    """
    Result type that represents either a success (Ok) or failure (Err)
    
    This is an enum-like type inspired by Rust and Haskell.
    """
    
    _value: Union[T, E]
    _is_ok: bool
    
    @staticmethod
    def ok(value: T) -> 'Result[T, E]':
        """Create a successful result"""
        return Result(value, True)
    
    @staticmethod
    def err(error: E) -> 'Result[T, E]':
        """Create a failed result"""
        return Result(error, False)
    
    def is_ok(self) -> bool:
        """Check if result is Ok"""
        return self._is_ok
    
    def is_err(self) -> bool:
        """Check if result is Err"""
        return not self._is_ok
    
    def unwrap(self) -> T:
        """Extract value, panic if Err"""
        if self.is_ok():
            return self._value
        raise RuntimeError(f"Called unwrap on Err: {self._value}")
    
    def unwrap_err(self) -> E:
        """Extract error, panic if Ok"""
        if self.is_err():
            return self._value
        raise RuntimeError(f"Called unwrap_err on Ok: {self._value}")
    
    def unwrap_or(self, default: T) -> T:
        """Extract value or return default"""
        return self._value if self.is_ok() else default
    
    def unwrap_or_else(self, func: Callable[[E], T]) -> T:
        """Extract value or compute from error"""
        return self._value if self.is_ok() else func(self._value)
    
    def map(self, func: Callable[[T], U]) -> 'Result[U, E]':
        """Transform Ok value"""
        if self.is_ok():
            return Result.ok(func(self._value))
        return Result(self._value, False)
    
    def map_err(self, func: Callable[[E], 'ResultError']) -> 'Result[T, ResultError]':
        """Transform error"""
        if self.is_err():
            return Result(func(self._value), False)
        return Result(self._value, True)
    
    def and_then(self, func: Callable[[T], 'Result[U, E]']) -> 'Result[U, E]':
        """Flatmap / monadic bind"""
        if self.is_ok():
            return func(self._value)
        return Result(self._value, False)
    
    def or_else(self, func: Callable[[E], "Result[T, ResultError]"]) -> "Result[T, ResultError]":
        """Handle error and potentially recover"""
        if self.is_err():
            return func(self._value)
        return Result(self._value, True)
    
    def __repr__(self) -> str:
        if self.is_ok():
            return f"Ok({self._value})"
        return f"Err({self._value})"


# Convenience aliases
Ok = Result.ok
Err = Result.err


# Service implementations using Result type
class VaultServiceWithResult:
    """Vault service using Result type instead of exceptions"""
    
    def __init__(self, db):
        self.db = db
    
    def get_vault(self, vault_id: str) -> Result[dict, VaultError]:
        """Get vault, returning Result instead of raising"""
        try:
            vault = self.db.query("vault").filter_by(id=vault_id).first()
            if not vault:
                return Err(NotFoundError("Vault", vault_id))
            return Ok(vault)
        except Exception as e:
            return Err(VaultError(str(e), code="DATABASE_ERROR"))
    
    def update_vault(self, vault_id: str, data: dict) -> Result[None, VaultError]:
        """Update vault safely"""
        return (self.get_vault(vault_id)
                .and_then(lambda vault: self._validate_data(data))
                .and_then(lambda _: self._do_update(vault_id, data)))
    
    def _validate_data(self, data: dict) -> Result[None, ValidationError]:
        """Validate vault data"""
        if not data:
            return Err(ValidationError("Vault data cannot be empty"))
        if "id" in data:
            return Err(ValidationError("Cannot modify vault ID"))
        return Ok(None)
    
    def _do_update(self, vault_id: str, data: dict) -> Result[None, VaultError]:
        """Actually update database"""
        try:
            self.db.update("vault", vault_id, data)
            return Ok(None)
        except Exception as e:
            return Err(VaultError(str(e), code="UPDATE_FAILED"))


class PKMServiceWithResult:
    """PKM service using Result type"""
    
    def __init__(self, db, cache):
        self.db = db
        self.cache = cache
    
    def get_pii_attribute(
        self,
        user_id: str,
        attribute: str,
    ) -> Result[str, ResultError]:
        """Get attribute with PII detection"""
        return (self._validate_access(user_id, attribute)
                .and_then(lambda _: self._fetch_attribute(user_id, attribute))
                .and_then(lambda value: self._sanitize_value(value)))
    
    def _validate_access(self, user_id: str, attr: str) -> Result[None, ResultError]:
        """Validate user has access"""
        # Validate consent token, scopes, etc.
        return Ok(None)
    
    def _fetch_attribute(self, user_id: str, attr: str) -> Result[str, ResultError]:
        """Fetch from cache or database"""
        cached = self.cache.get(f"{user_id}:{attr}")
        if cached:
            return Ok(cached)
        
        # Fetch from DB
        value = self.db.query(user_id, attr).first()
        if value:
            return Ok(value)
        
        return Err(NotFoundError("Attribute", attr))
    
    def _sanitize_value(self, value: str) -> Result[str, ResultError]:
        """Remove any PII from value"""
        try:
            sanitized = self._remove_pii(value)
            return Ok(sanitized)
        except Exception as e:
            return Err(PKMError(str(e)))
    
    def _remove_pii(self, value: str) -> str:
        # PII removal logic
        return value


# Error handler middleware for FastAPI


class ResultErrorMiddleware(BaseHTTPMiddleware):
    """Convert ResultError to HTTP responses"""
    
    async def dispatch(self, request: Request, call_next):
        try:
            return await call_next(request)
        except ResultError as e:
            status_map = {
                "NOT_FOUND": 404,
                "UNAUTHORIZED": 401,
                "VALIDATION_ERROR": 400,
                "DATABASE_ERROR": 500,
            }
            status = status_map.get(e.code, 500)
            
            return JSONResponse(
                status_code=status,
                content={
                    "error": {
                        "code": e.code,
                        "message": e.message,
                    }
                }
            )


# Route handler pattern

router = APIRouter()


@router.get("/vault/{vault_id}")
async def get_vault(
    vault_id: str,
    vault_service: VaultServiceWithResult = Depends(),
) -> dict:
    """Endpoint using Result type"""
    result = vault_service.get_vault(vault_id)
    
    if result.is_ok():
        return {"vault": result.unwrap()}
    
    # Middleware or error handler converts ResultError to HTTP response
    raise result.unwrap_err()


@router.post("/vault/{vault_id}")
async def update_vault(
    vault_id: str,
    data: dict,
    vault_service: VaultServiceWithResult = Depends(),
) -> dict:
    """Update vault using Result chaining"""
    result = vault_service.update_vault(vault_id, data)
    
    if result.is_ok():
        return {"status": "updated"}
    
    error = result.unwrap_err()
    raise error


# Testing helpers
class ResultAssert:
    """Test helpers for Result type"""
    
    @staticmethod
    def assert_ok(result: Result, expected_value=None) -> None:
        """Assert result is Ok"""
        assert result.is_ok(), f"Expected Ok but got {result}"  # noqa: S101
        if expected_value is not None:
            assert result.unwrap() == expected_value  # noqa: S101
    
    @staticmethod
    def assert_err(result: Result, error_code=None) -> None:
        """Assert result is Err"""
        assert result.is_err(), f"Expected Err but got {result}"  # noqa: S101
        if error_code is not None:
            error = result.unwrap_err()
            assert error.code == error_code, f"Expected {error_code} but got {error.code}"  # noqa: S101
