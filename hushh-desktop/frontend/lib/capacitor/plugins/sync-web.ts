/**
 * HushhSync Web Fallback Implementation
 *
 * Web fallback for sync operations - calls API routes.
 * On iOS, the native HushhSyncPlugin is used instead.
 */

import { WebPlugin } from "@capacitor/core";
import type { HushhSyncPlugin, SyncResult, SyncStatus } from "../index";

export class HushhSyncWeb extends WebPlugin implements HushhSyncPlugin {
  
  async sync(_options?: { authToken?: string }): Promise<SyncResult> {
    console.warn("[HushhSyncWeb] Remote sync disabled");
    return {
      success: false,
      pushedRecords: 0,
      pulledRecords: 0,
      conflicts: 0,
      timestamp: Date.now(),
    };
  }

  async push(_options?: { authToken?: string }): Promise<{ success: boolean; pushedRecords: number }> {
    console.warn("[HushhSyncWeb] Remote sync disabled");
    return { success: false, pushedRecords: 0 };
  }

  async pull(_options?: { authToken?: string }): Promise<{ success: boolean; pulledRecords: number }> {
    console.warn("[HushhSyncWeb] Remote sync disabled");
    return { success: false, pulledRecords: 0 };
  }

  async syncVault(_options: { userId: string; authToken?: string }): Promise<{ success: boolean }> {
    console.warn("[HushhSyncWeb] Remote sync disabled");
    return { success: false };
  }

  async getSyncStatus(): Promise<SyncStatus> {
    return {
      pendingCount: 0,
      lastSyncTimestamp: 0,
      hasPendingChanges: false,
    };
  }
}
