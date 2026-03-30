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
  debateSessionId?: string;
}): Promise<{ analysisId: string }> {
  const debateSessionId = String(params.debateSessionId || "").trim();
  if (!debateSessionId) {
    throw new Error(
      "Kai polling requires a debateSessionId. Legacy /api/kai/analyze/start is removed; use current run APIs instead."
    );
  }

  const response = await ApiService.apiFetch("/api/kai/analyze/run/start", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${params.vaultOwnerToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      ticker: params.ticker,
      user_id: params.userId,
      debate_session_id: debateSessionId,
      risk_profile: params.riskProfile,
      context: params.userContext,
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(error || "Failed to start analysis");
  }

  const data = (await response.json()) as {
    run?: {
      run_id?: string;
    };
  };
  const analysisId = String(data.run?.run_id || "").trim();
  if (!analysisId) {
    throw new Error("Analyze run response did not include run.run_id");
  }
  return { analysisId };
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
  void analysisId;
  void vaultOwnerToken;
  void onProgress;
  void pollInterval;
  void maxAttempts;
  throw new Error(
    "Kai polling status endpoint is no longer supported. Use ApiService.streamKaiDebateRun or ApiService.getActiveKaiDebateRun instead."
  );
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
    debateSessionId?: string;
  },
  onProgress?: (progress: number, status: string) => void
): Promise<AnalyzeResponse> {
  void params;
  onProgress?.(0, "unsupported");
  throw new Error(
    "Kai polling status endpoint is no longer supported. Use ApiService.streamKaiDebateRun or ApiService.getActiveKaiDebateRun instead."
  );
}
