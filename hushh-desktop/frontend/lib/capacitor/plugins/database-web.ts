/**
 * Hussh Local Database - IndexedDB Implementation
 * 
 * Provides persistent storage for web platform using IndexedDB.
 * DEV: Data also syncs to cloud (useRemoteSync: true by default).
 */

import type { HushhDatabasePlugin } from "../index";

const DB_NAME = 'hushh_vault';
const DB_VERSION = 1;

const STORES = {
  vaultKeys: 'vault_keys',
  consentTokens: 'consent_tokens',
  syncQueue: 'sync_queue',
};

export class HushhDatabaseWeb implements HushhDatabasePlugin {
  private db: IDBDatabase | null = null;
  private initPromise: Promise<IDBDatabase> | null = null;

  async initialize(): Promise<{ success: boolean }> {
    if (this.db) return { success: true };
    try {
      this.db = await this.openDatabase();
      console.log('[HushhDatabaseWeb] IndexedDB initialized');
      return { success: true };
    } catch (error) {
      console.error('[HushhDatabaseWeb] Failed to initialize:', error);
      throw error;
    }
  }

  private openDatabase(): Promise<IDBDatabase> {
    if (this.initPromise) return this.initPromise;

    this.initPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onerror = () => reject(new Error(`IndexedDB error: ${request.error?.message}`));
      request.onsuccess = () => resolve(request.result);
      request.onupgradeneeded = (event) => {
        const db = (event.target as IDBOpenDBRequest).result;
        if (!db.objectStoreNames.contains(STORES.vaultKeys)) {
          const vaultKeys = db.createObjectStore(STORES.vaultKeys, { keyPath: 'userId' });
          vaultKeys.createIndex('authMethod', 'authMethod', { unique: false });
        }
        if (!db.objectStoreNames.contains(STORES.consentTokens)) {
          const tokens = db.createObjectStore(STORES.consentTokens, { keyPath: 'tokenId' });
          tokens.createIndex('userId', 'userId', { unique: false });
        }
        if (!db.objectStoreNames.contains(STORES.syncQueue)) {
          const syncQueue = db.createObjectStore(STORES.syncQueue, { keyPath: 'id', autoIncrement: true });
          syncQueue.createIndex('synced', 'synced', { unique: false });
        }
      };
    });
    return this.initPromise;
  }

  private async getDB(): Promise<IDBDatabase> {
    if (!this.db) this.db = await this.openDatabase();
    return this.db;
  }

  async hasVault(options: { userId: string }): Promise<{ exists: boolean }> {
    const db = await this.getDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORES.vaultKeys, 'readonly');
      const store = tx.objectStore(STORES.vaultKeys);
      const request = store.get(options.userId);
      request.onsuccess = () => resolve({ exists: request.result !== undefined });
      request.onerror = () => reject(request.error);
    });
  }

  async storeVaultKey(options: {
    userId: string;
    authMethod: string;
    encryptedVaultKey: string;
    salt: string;
    iv: string;
    recoveryEncryptedVaultKey: string;
    recoverySalt: string;
    recoveryIv: string;
  }): Promise<{ success: boolean }> {
    const db = await this.getDB();
    const now = Date.now();
    return new Promise((resolve, reject) => {
      const tx = db.transaction([STORES.vaultKeys, STORES.syncQueue], 'readwrite');
      const vaultStore = tx.objectStore(STORES.vaultKeys);
      const syncStore = tx.objectStore(STORES.syncQueue);
      const record = { ...options, createdAt: now, updatedAt: now };
      vaultStore.put(record);
      syncStore.add({
        tableName: STORES.vaultKeys,
        operation: 'UPSERT',
        userId: options.userId,
        data: JSON.stringify(record),
        createdAt: now,
        synced: false,
      });
      tx.oncomplete = () => resolve({ success: true });
      tx.onerror = () => reject(tx.error);
    });
  }

  async getVaultKey(options: { userId: string }): Promise<{
    encryptedVaultKey: string;
    salt: string;
    iv: string;
    recoveryEncryptedVaultKey: string;
    recoverySalt: string;
    recoveryIv: string;
  }> {
    const db = await this.getDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORES.vaultKeys, 'readonly');
      const store = tx.objectStore(STORES.vaultKeys);
      const request = store.get(options.userId);
      request.onsuccess = () => {
        if (!request.result) { reject(new Error('Vault not found')); return; }
        resolve({
          encryptedVaultKey: request.result.encryptedVaultKey,
          salt: request.result.salt,
          iv: request.result.iv,
          recoveryEncryptedVaultKey: request.result.recoveryEncryptedVaultKey,
          recoverySalt: request.result.recoverySalt,
          recoveryIv: request.result.recoveryIv,
        });
      };
      request.onerror = () => reject(request.error);
    });
  }

  async close(): Promise<{ success: boolean }> {
    if (this.db) { this.db.close(); this.db = null; this.initPromise = null; }
    return { success: true };
  }
}
