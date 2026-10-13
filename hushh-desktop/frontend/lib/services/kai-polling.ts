/**
 * Kai Analysis Polling Service
 * =============================
 * 
 * Provides polling-based analysis status checking for native platforms
 * where SSE streaming doesn't work.
 * 
 * Architecture:
 * - Web: Uses SSE streaming (real-time)
 * - Native: Uses polling (fallback)
 * 
 * Flow:
 * 1. Start analysis → Get analysis_id
 * 2. Poll status endpoint every 1-2 seconds
 * 3. Update progress callback
 * 4. Return final result when complete
 */

import { ApiService } from "@/lib/services/api-service";
import type { AnalyzeResponse } from "@/lib/services/kai-service";

export interface AnalysisStatus {
  status: "pending" | "processing" | "complete" | "error";
  progress?: number;
  result?: AnalyzeResponse;
  error?: string;
}

/**
 * Start Kai analysis (returns analysis ID immediately)
 * 
 * This initiates the analysis on the backend and returns an ID
 * that can be used to poll for status.
 * 
 * @param params - Analysis parameters
 * @returns Promise with analysis ID
 */
export async function startKaiAnalysis(params: {
  userId: string;
  ticker: string;
  riskProfile?: string;
  userContext?: string;
  vaultOwnerToken: string;
}): Promise<{ analysisId: string }> {
  const response = await ApiService.apiFetch("/api/kai/analyze/start", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${params.vaultOwnerToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      ticker: params.ticker,
      user_id: params.userId,
      risk_profile: params.riskProfile,
      context: params.userContext,
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(error || "Failed to start analysis");
  }

  const data = await response.json();
  return { analysisId: data.analysis_id };
}

/**
 * Poll for analysis status (native fallback)
 * 
 * Polls the backend every `pollInterval` ms until the analysis
 * is complete or an error occurs.
 * 
 * @param analysisId - Analysis ID from startKaiAnalysis
 * @param vaultOwnerToken - VAULT_OWNER token for auth
 * @param onProgress - Callback for progress updates (0-100)
 * @param pollInterval - Polling interval in ms (default: 1000)
 * @param maxAttempts - Max polling attempts (default: 120 = 2 minutes)
 * @returns Promise with final analysis result
 */
export async function pollKaiAnalysisStatus(
  analysisId: string,
  vaultOwnerToken: string,
  onProgress?: (progress: number, status: string) => void,
  pollInterval: number = 1000,
  maxAttempts: number = 120
): Promise<AnalyzeResponse> {
  console.log(`[Kai Polling] Starting poll for analysis ${analysisId}`);

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      const response = await ApiService.apiFetch(
        `/api/kai/analysis/${analysisId}/status`,
        {
          headers: {
            Authorization: `Bearer ${vaultOwnerToken}`,
          },
        }
      );

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${await response.text()}`);
      }

      const data: AnalysisStatus = await response.json();

      console.log(
        `[Kai Polling] Attempt ${attempt + 1}/${maxAttempts}: ${data.status}`
      );

      // Analysis complete - return result
      if (data.status === "complete" && data.result) {
        console.log("[Kai Polling] ✅ Analysis complete");
        onProgress?.(100, "complete");
        return data.result;
      }

      // Analysis error
      if (data.status === "error") {
        console.error("[Kai Polling] ❌ Analysis error:", data.error);
        throw new Error(data.error || "Analysis failed");
      }

      // Still processing - report progress
      const progress = data.progress || (attempt / maxAttempts) * 100;
      onProgress?.(Math.min(progress, 99), data.status);

      // Wait before next poll
      await new Promise((resolve) => setTimeout(resolve, pollInterval));
    } catch (error) {
      console.error(`[Kai Polling] Error on attempt ${attempt + 1}:`, error);

      // If we're near the end of attempts, throw the error
      if (attempt >= maxAttempts - 3) {
        throw error;
      }

      // Otherwise, wait and retry
      await new Promise((resolve) => setTimeout(resolve, pollInterval));
    }
  }

  // Timeout
  console.error("[Kai Polling] ⏱️ Analysis timeout");
  throw new Error("Analysis timeout - please try again");
}

/**
 * Combined function: Start analysis and poll for result
 * 
 * Convenience function that combines startKaiAnalysis and pollKaiAnalysisStatus.
 * Use this for a simple one-call solution.
 * 
 * @param params - Analysis parameters
 * @param onProgress - Progress callback
 * @returns Promise with final analysis result
 */
export async function analyzeWithPolling(
  params: {
    userId: string;
    ticker: string;
    riskProfile?: string;
    userContext?: string;
    vaultOwnerToken: string;
  },
  onProgress?: (progress: number, status: string) => void
): Promise<AnalyzeResponse> {
  console.log("[Kai Polling] Starting analysis with polling...");

  // Step 1: Start analysis
  onProgress?.(5, "starting");
  const { analysisId } = await startKaiAnalysis(params);

  console.log(`[Kai Polling] Analysis started: ${analysisId}`);

  // Step 2: Poll for result
  onProgress?.(10, "processing");
  const result = await pollKaiAnalysisStatus(
    analysisId,
    params.vaultOwnerToken,
    onProgress
  );

  return result;
}
