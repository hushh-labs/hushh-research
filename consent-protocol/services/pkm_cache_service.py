"""
PKM Service Cache Optimization

Implements TTL-based cache invalidation for PersonalKnowledgeModelService
to reduce repeated database queries for frequently-accessed attributes.

Caches:
- Stock ticker metadata
- Sector classifications  
- Broker configuration
- User consent scopes
- Market data snapshots
"""

import json
import time
from dataclasses import dataclass
from typing import Any, Dict, Generic, Optional, TypeVar

try:
    import redis
    HAS_REDIS = True
except ImportError:
    HAS_REDIS = False

T = TypeVar('T')


@dataclass
class CacheConfig:
    """Cache configuration"""
    default_ttl: int = 3600  # 1 hour
    max_size: int = 10000
    enable_compression: bool = False


class CacheEntry(Generic[T]):
    """Generic cache entry with TTL"""
    
    def __init__(self, value: T, ttl: int):
        self.value = value
        self.created_at = time.time()
        self.ttl = ttl
    
    def is_expired(self) -> bool:
        """Check if entry has expired"""
        return time.time() - self.created_at > self.ttl
    
    def get(self) -> Optional[T]:
        """Get value if not expired"""
        if self.is_expired():
            return None
        return self.value


class InMemoryCache:
    """Simple in-memory cache with TTL support"""
    
    def __init__(self, config: Optional[CacheConfig] = None):
        self.config = config or CacheConfig()
        self.cache: Dict[str, CacheEntry] = {}
    
    def get(self, key: str) -> Optional[Any]:
        """Get value from cache"""
        if key not in self.cache:
            return None
        
        entry = self.cache[key]
        value = entry.get()
        
        # Clean up expired entries
        if value is None:
            del self.cache[key]
        
        return value
    
    def set(self, key: str, value: Any, ttl: Optional[int] = None) -> None:
        """Set value in cache"""
        if len(self.cache) >= self.config.max_size:
            # Simple eviction: remove expired entries first
            expired_keys = [k for k, v in self.cache.items() if v.is_expired()]
            for k in expired_keys:
                del self.cache[k]
        
        ttl = ttl or self.config.default_ttl
        self.cache[key] = CacheEntry(value, ttl)
    
    def invalidate(self, pattern: Optional[str] = None) -> None:
        """Invalidate cache entries"""
        if pattern is None:
            self.cache.clear()
        else:
            # Invalidate keys matching pattern
            keys_to_delete = [k for k in self.cache if pattern in k]
            for k in keys_to_delete:
                del self.cache[k]


class RedisCache:
    """Redis-backed cache for distributed systems"""
    
    def __init__(self, redis_client: 'redis.Redis', config: Optional[CacheConfig] = None):
        self.redis = redis_client
        self.config = config or CacheConfig()
    
    def get(self, key: str) -> Optional[Any]:
        """Get value from Redis"""
        try:
            value = self.redis.get(key)
            if value is None:
                return None
            return json.loads(value)
        except Exception:
            # Log error but don't fail
            return None
    
    def set(self, key: str, value: Any, ttl: Optional[int] = None) -> None:
        """Set value in Redis"""
        ttl = ttl or self.config.default_ttl
        try:
            self.redis.setex(
                key,
                ttl,
                json.dumps(value, default=str)
            )
        except Exception:
            # Log error but don't fail
            pass
    
    def invalidate(self, pattern: Optional[str] = None) -> None:
        """Invalidate cache entries"""
        if pattern is None:
            self.redis.flushdb()
        else:
            # Use Redis SCAN for pattern matching
            keys = self.redis.keys(f"*{pattern}*")
            if keys:
                self.redis.delete(*keys)


class PKMCacheKey:
    """Cache key builder for PKM service"""
    
    @staticmethod
    def ticker_metadata(symbol: str) -> str:
        """Key for ticker metadata cache"""
        return f"pkm:ticker:{symbol.upper()}"
    
    @staticmethod
    def sector_classification(symbol: str) -> str:
        """Key for sector classification cache"""
        return f"pkm:sector:{symbol.upper()}"
    
    @staticmethod
    def user_scopes(user_id: str) -> str:
        """Key for user consent scopes cache"""
        return f"pkm:scopes:{user_id}"
    
    @staticmethod
    def broker_config(broker_name: str) -> str:
        """Key for broker configuration cache"""
        return f"pkm:broker:{broker_name}"
    
    @staticmethod
    def market_snapshot(market: str, timestamp: int) -> str:
        """Key for market data snapshot cache"""
        # Snapshot valid for 1 minute
        minute_bucket = timestamp // 60
        return f"pkm:market:{market}:{minute_bucket}"


class CachedPKMService:
    """Wrapper around PKMService with caching"""
    
    def __init__(self, pkm_service, cache: Optional[Any] = None):
        self.pkm_service = pkm_service
        
        # Initialize cache (Redis if available, else in-memory)
        if cache:
            self.cache = cache
        elif HAS_REDIS:
            try:
                redis_client = redis.Redis.from_url("redis://localhost:6379/0")
                redis_client.ping()
                self.cache = RedisCache(redis_client)
            except Exception:
                self.cache = InMemoryCache()
        else:
            self.cache = InMemoryCache()
    
    def get_ticker_metadata(self, symbol: str) -> Dict[str, Any]:
        """
        Get ticker metadata with caching
        
        Cache TTL: 24 hours (tickers don't change often)
        """
        cache_key = PKMCacheKey.ticker_metadata(symbol)
        
        # Try cache first
        cached = self.cache.get(cache_key)
        if cached is not None:
            return cached
        
        # Cache miss: fetch from service
        metadata = self.pkm_service.get_ticker_metadata(symbol)
        
        # Cache for 24 hours
        self.cache.set(cache_key, metadata, ttl=86400)
        
        return metadata
    
    def get_user_scopes(self, user_id: str) -> Dict[str, list]:
        """
        Get user consent scopes with caching
        
        Cache TTL: 5 minutes (scopes can change frequently)
        """
        cache_key = PKMCacheKey.user_scopes(user_id)
        
        cached = self.cache.get(cache_key)
        if cached is not None:
            return cached
        
        scopes = self.pkm_service.get_user_scopes(user_id)
        self.cache.set(cache_key, scopes, ttl=300)
        
        return scopes
    
    def get_sector_classification(self, symbol: str) -> str:
        """
        Get sector classification with caching
        
        Cache TTL: 24 hours
        """
        cache_key = PKMCacheKey.sector_classification(symbol)
        
        cached = self.cache.get(cache_key)
        if cached is not None:
            return cached
        
        sector = self.pkm_service.get_sector_classification(symbol)
        self.cache.set(cache_key, sector, ttl=86400)
        
        return sector
    
    def get_broker_config(self, broker_name: str) -> Dict[str, Any]:
        """
        Get broker configuration with caching
        
        Cache TTL: 1 hour (config changes infrequently)
        """
        cache_key = PKMCacheKey.broker_config(broker_name)
        
        cached = self.cache.get(cache_key)
        if cached is not None:
            return cached
        
        config = self.pkm_service.get_broker_config(broker_name)
        self.cache.set(cache_key, config, ttl=3600)
        
        return config
    
    def invalidate_user_scopes(self, user_id: str) -> None:
        """Invalidate cached scopes when user updates consent"""
        self.cache.invalidate(pattern=f"pkm:scopes:{user_id}")
    
    def invalidate_ticker_data(self, symbol: Optional[str] = None) -> None:
        """Invalidate ticker cache (all or specific)"""
        if symbol:
            self.cache.invalidate(pattern=symbol.upper())
        else:
            self.cache.invalidate(pattern="pkm:ticker:")
    
    def get_cache_stats(self) -> Dict[str, Any]:
        """Get cache statistics"""
        if isinstance(self.cache, RedisCache):
            try:
                info = self.cache.redis.info()
                return {
                    "used_memory": info.get("used_memory_human"),
                    "connected_clients": info.get("connected_clients"),
                    "hits": info.get("keyspace_hits", 0),
                    "misses": info.get("keyspace_misses", 0),
                }
            except Exception:
                return {}
        elif isinstance(self.cache, InMemoryCache):
            return {
                "size": len(self.cache.cache),
                "max_size": self.cache.config.max_size,
            }
        
        return {}


class CacheWarmup:
    """Pre-load cache on startup"""
    
    def __init__(self, cached_service: CachedPKMService):
        self.cached_service = cached_service
    
    async def warmup_ticker_cache(self, symbols: list) -> None:
        """Pre-load ticker metadata into cache"""
        for symbol in symbols:
            self.cached_service.get_ticker_metadata(symbol)
    
    async def warmup_sector_cache(self, symbols: list) -> None:
        """Pre-load sector classifications into cache"""
        for symbol in symbols:
            self.cached_service.get_sector_classification(symbol)
