import { ApiService } from "./api-service";

export interface SkillValidationRequest {
  skillName: string;
  githubUsername: string;
  userId?: string;
}

export interface SkillValidationTaskResponse {
  taskId: string;
  status: 'pending' | 'processing' | 'completed' | 'failed' | 'timeout';
  result?: {
    score: number;
    level: string;
    evidence: any[];
    confidence: number;
  };
  error?: string;
  retryCount?: number;
}

export class SkillValidationService {
  static async createValidationTask(
    request: SkillValidationRequest
  ): Promise<SkillValidationTaskResponse> {
    const response = await ApiService.apiFetch("/api/skills/validate", {
      method: "POST",
      body: JSON.stringify(request),
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: "Failed to create validation task" }));
      throw new Error(error.error || "Failed to create validation task");
    }

    return response.json();
  }

  static async getTaskStatus(taskId: string): Promise<SkillValidationTaskResponse> {
    const response = await ApiService.apiFetch(`/api/skills/validate?taskId=${taskId}`, {
      method: "GET",
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: "Failed to get task status" }));
      throw new Error(error.error || "Failed to get task status");
    }

    return response.json();
  }

  static async pollTaskStatus(
    taskId: string,
    maxAttempts = 30,
    intervalMs = 1000
  ): Promise<SkillValidationTaskResponse> {
    for (let i = 0; i < maxAttempts; i++) {
      await new Promise(resolve => setTimeout(resolve, intervalMs));
      
      const result = await this.getTaskStatus(taskId);

      if (result.status === 'completed' || result.status === 'failed') {
        return result;
      }
    }

    return { taskId, status: 'timeout' as const };
  }

  static async validateSkill(request: SkillValidationRequest): Promise<SkillValidationTaskResponse> {
    const task = await this.createValidationTask(request);
    return this.pollTaskStatus(task.taskId);
  }
}