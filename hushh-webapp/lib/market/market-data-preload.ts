'use client';

/**
 * Market Data Preload Strategy
 * 
 * Implements eager preloading of market data (tickers, sectors, quotes)
 * in Service Worker before route navigation. Reduces perceived latency
 * when users navigate to market-related pages.
 * 
 * Strategy:
 * 1. Background preload on app startup
 * 2. Predictive preload on route hover
 * 3. Batch API calls to minimize requests
 */

import { useEffect, useRef } from 'react';
import { ApiService } from "@/lib/services/api-service";

interface PreloadConfig {
  tickerSymbols: string[];
  marketData: string[];
  refreshInterval: number;  // milliseconds
}

const DEFAULT_CONFIG: PreloadConfig = {
  tickerSymbols: [
    // Top US stocks
    'AAPL', 'MSFT', 'GOOGL', 'AMZN', 'NVDA',
    'TSLA', 'META', 'BERKB', 'V', 'JNJ',
    // Top sectors
    'XLK', 'XLV', 'XLF', 'XLY', 'XLI', 'XLE', 'XLRE', 'XLU', 'XLP', 'XLR'
  ],
  marketData: [
    'market:us',
    'market:indices',
    'market:bonds',
  ],
  refreshInterval: 300000,  // 5 minutes
};

/**
 * Service Worker API for background data preloading
 */
class MarketDataPreloader {
  private isRegistered = false;
  private preloadQueue: Set<string> = new Set();
  private lastRefresh: Map<string, number> = new Map();
  
  /**
   * Register Service Worker for background preloading
   */
  async registerServiceWorker(): Promise<void> {
    if (typeof window === 'undefined' || !('serviceWorker' in navigator)) {
      return;
    }
    
    try {
      await navigator.serviceWorker.register('/sw-market-data.js', {
        scope: '/',
        updateViaCache: 'none',
      });
      this.isRegistered = true;
      console.debug('Market data Service Worker registered');
    } catch (error) {
      console.warn('Failed to register market data Service Worker:', error);
    }
  }
  
  /**
   * Send preload request to Service Worker
   */
  private async sendToServiceWorker(
    data: any
  ): Promise<void> {
    if (!this.isRegistered) {
      return;
    }
    
    const controller = navigator.serviceWorker.controller;
    if (controller) {
      controller.postMessage({
        type: 'PRELOAD_MARKET_DATA',
        payload: data,
      });
    }
  }
  
  /**
   * Preload market data in background
   */
  async preloadTickerData(symbols: string[]): Promise<void> {
    // Batch requests
    const batchSize = 20;
    const batches = [];
    
    for (let i = 0; i < symbols.length; i += batchSize) {
      batches.push(symbols.slice(i, i + batchSize));
    }
    
    for (const batch of batches) {
      // Skip recent symbols to avoid redundant requests
      const toPreload = batch.filter(symbol => {
        const lastFetch = this.lastRefresh.get(symbol) || 0;
        return Date.now() - lastFetch > DEFAULT_CONFIG.refreshInterval;
      });
      
      if (toPreload.length === 0) continue;
      
      try {
        // Fetch ticker data
        const response = await ApiService.apiFetch('/api/market/tickers', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ symbols: toPreload }),
          priority: 'low' as RequestPriority,
        });
        
        if (response.ok) {
          const data = await response.json();
          
          // Store in IndexedDB/Cache
          await this.cacheMarketData('tickers', toPreload, data);
          
          // Update refresh timestamp
          toPreload.forEach(s => {
            this.lastRefresh.set(s, Date.now());
          });
          
          // Send to Service Worker for background caching
          await this.sendToServiceWorker({
            type: 'CACHE_TICKERS',
            symbols: toPreload,
            data: data,
          });
        }
      } catch (error) {
        console.warn('Failed to preload ticker data:', error);
      }
    }
  }
  
  /**
   * Preload market summary data
   */
  async preloadMarketSummary(): Promise<void> {
    try {
      const response = await ApiService.apiFetch('/api/market/summary', {
        priority: 'low' as RequestPriority,
      });
      
      if (response.ok) {
        const data = await response.json();
        await this.cacheMarketData('summary', ['all'], data);
        await this.sendToServiceWorker({
          type: 'CACHE_SUMMARY',
          data: data,
        });
      }
    } catch (error) {
      console.warn('Failed to preload market summary:', error);
    }
  }
  
  /**
   * Cache data in IndexedDB
   */
  private async cacheMarketData(
    storeName: string,
    keys: string[],
    data: any
  ): Promise<void> {
    if (typeof window === 'undefined' || !('indexedDB' in window)) {
      return;
    }
    
    try {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open('marketData', 1);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
        request.onupgradeneeded = (event) => {
          const db = (event.target as IDBOpenDBRequest).result;
          if (!db.objectStoreNames.contains(storeName)) {
            db.createObjectStore(storeName, { keyPath: 'key' });
          }
        };
      });
      
      const transaction = db.transaction(storeName, 'readwrite');
      const store = transaction.objectStore(storeName);
      
      for (const key of keys) {
        store.put({
          key,
          data,
          cached_at: Date.now(),
        });
      }
      
      await new Promise((resolve, reject) => {
        transaction.oncomplete = () => resolve(undefined);
        transaction.onerror = () => reject(transaction.error);
      });
    } catch (error) {
      console.warn('Failed to cache market data in IndexedDB:', error);
    }
  }
  
  /**
   * Retrieve cached data from IndexedDB
   */
  async getCachedData(storeName: string, key: string): Promise<any> {
    if (typeof window === 'undefined' || !('indexedDB' in window)) {
      return null;
    }
    
    try {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open('marketData', 1);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      
      const transaction = db.transaction(storeName, 'readonly');
      const store = transaction.objectStore(storeName);
      
      return new Promise((resolve) => {
        const request = store.get(key);
        request.onsuccess = () => {
          const result = request.result;
          if (result && Date.now() - result.cached_at < DEFAULT_CONFIG.refreshInterval) {
            resolve(result.data);
          } else {
            resolve(null);
          }
        };
        request.onerror = () => resolve(null);
      });
    } catch {
      return null;
    }
  }
  
  /**
   * Predictively preload data on route hover
   */
  predictivePreload(route: string): void {
    // Map routes to data dependencies
    const dataMap: Record<string, string[]> = {
      '/portfolio': ['AAPL', 'MSFT', 'GOOGL', 'AMZN', 'NVDA'],
      '/market': ['XLK', 'XLV', 'XLF', 'XLY', 'XLI', 'XLE'],
      '/watchlist': ['AAPL', 'MSFT', 'GOOGL', 'AMZN', 'NVDA', 'TSLA', 'META'],
    };
    
    const symbols = dataMap[route] || [];
    if (symbols.length > 0) {
      // Low priority preload
      if (typeof requestIdleCallback !== 'undefined') {
        requestIdleCallback(() => this.preloadTickerData(symbols));
      } else {
        setTimeout(() => this.preloadTickerData(symbols), 1000);
      }
    }
  }
}

// Singleton instance
let _preloader: MarketDataPreloader | null = null;

export function useMarketDataPreload() {
  const preloaderRef = useRef<MarketDataPreloader | null>(null);
  
  useEffect(() => {
    if (!preloaderRef.current) {
      preloaderRef.current = new MarketDataPreloader();
      preloaderRef.current.registerServiceWorker();
    }
    
    const preloader = preloaderRef.current;
    
    // Initial preload on app startup
    if (typeof requestIdleCallback !== 'undefined') {
      requestIdleCallback(() => {
        preloader.preloadTickerData(DEFAULT_CONFIG.tickerSymbols);
        preloader.preloadMarketSummary();
      });
    } else {
      setTimeout(() => {
        preloader.preloadTickerData(DEFAULT_CONFIG.tickerSymbols);
        preloader.preloadMarketSummary();
      }, 2000);
    }
    
    // Periodic refresh
    const refreshInterval = setInterval(() => {
      preloader.preloadTickerData(DEFAULT_CONFIG.tickerSymbols);
      preloader.preloadMarketSummary();
    }, DEFAULT_CONFIG.refreshInterval);
    
    return () => clearInterval(refreshInterval);
  }, []);
  
  return {
    preloadTickerData: (symbols: string[]) => preloaderRef.current?.preloadTickerData(symbols),
    preloadMarketSummary: () => preloaderRef.current?.preloadMarketSummary(),
    predictivePreload: (route: string) => preloaderRef.current?.predictivePreload(route),
    getCachedData: (store: string, key: string) => preloaderRef.current?.getCachedData(store, key),
  };
}

/**
 * Service Worker implementation (saved as public/sw-market-data.js)
 * 
 * self.addEventListener('install', (event) => {
 *   self.skipWaiting();
 * });
 * 
 * self.addEventListener('message', (event) => {
 *   if (event.data.type === 'PRELOAD_MARKET_DATA') {
 *     // Handle preload in service worker
 *     caches.open('market-data-v1').then(cache => {
 *       cache.addAll(event.data.payload.urls);
 *     });
 *   }
 * });
 */
