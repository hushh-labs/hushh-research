export interface Skill {
  name: string;
  isVerified: boolean;
  verificationScore?: number;
  verificationLevel?: VerificationLevel;
  githubEvidence?: GitHubEvidence[];
  createdAt?: Date;
  updatedAt?: Date;
}

export type VerificationLevel = 'expert' | 'verified' | 'partial' | 'unverified';

export interface GitHubEvidence {
  repoName: string;
  repoUrl: string;
  stars: number;
  commits: number;
  languages: string[];
  hasReadme: boolean;
  hasPackageJson: boolean;
  isFork: boolean;
  lastUpdated: string;
}

export interface ValidationTask {
  id: string;
  skillName: string;
  userId: string;
  status: ValidationStatus;
  createdAt: Date;
  updatedAt: Date;
  result?: ValidationResult;
  error?: string;
  retryCount: number;
}

export type ValidationStatus = 'pending' | 'processing' | 'completed' | 'failed';

export interface ValidationResult {
  score: number;
  level: VerificationLevel;
  evidence: GitHubEvidence[];
  confidence: number;
}

export interface ValidationTaskRequest {
  skillName: string;
  githubUsername: string;
}

export interface ValidationTaskResponse {
  taskId: string;
  status: ValidationStatus;
}

export function getVerificationLevel(score: number): VerificationLevel {
  if (score >= 90) return 'expert';
  if (score >= 70) return 'verified';
  if (score >= 40) return 'partial';
  return 'unverified';
}

export function getVerificationLabel(level: VerificationLevel): string {
  const labels = {
    expert: 'Expert Verified',
    verified: 'Verified',
    partial: 'Partial Proof',
    unverified: 'Unverified'
  };
  return labels[level];
}