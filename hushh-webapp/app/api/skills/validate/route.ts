import { NextRequest, NextResponse } from 'next/server';
import { v4 as uuidv4 } from 'uuid';

interface ValidationTask {
  id: string;
  skillName: string;
  githubUsername: string;
  userId: string;
  status: 'pending' | 'processing' | 'completed' | 'failed';
  createdAt: Date;
  updatedAt: Date;
  result?: {
    score: number;
    level: string;
    evidence: any[];
    confidence: number;
  };
  error?: string;
  retryCount: number;
}

const validationQueue: Map<string, ValidationTask> = new Map();
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;

interface GitHubRepo {
  id: number;
  name: string;
  full_name: string;
  html_url: string;
  stargazers_count: number;
  forks_count: number;
  language: string | null;
  created_at: string;
  updated_at: string;
  pushed_at: string;
  fork: boolean;
  size: number;
  default_branch: string;
}

async function validateSkillWithGitHub(skillName: string, githubUsername: string): Promise<{
  score: number;
  level: string;
  evidence: any[];
  confidence: number;
}> {
  const normalizedSkill = skillName.toLowerCase().trim();
  
  const skillKeywords: Record<string, string[]> = {
    'react': ['react', 'jsx', 'tsx', 'next.js', 'nextjs'],
    'typescript': ['typescript', 'ts'],
    'javascript': ['javascript', 'js'],
    'python': ['python', 'py'],
    'node': ['node', 'nodejs', 'express'],
    'ai': ['ai', 'ml', 'machine learning', 'deep learning', 'tensorflow', 'pytorch'],
    'machine learning': ['ml', 'machine learning', 'tensorflow', 'pytorch', 'sklearn'],
    'data science': ['pandas', 'numpy', 'jupyter', 'data analysis'],
    'devops': ['docker', 'kubernetes', 'ci/cd', 'jenkins', 'terraform'],
    'golang': ['go', 'golang'],
    'rust': ['rust'],
    'java': ['java', 'spring'],
    'csharp': ['c#', 'csharp', '.net'],
  };

  const searchTerms = skillKeywords[normalizedSkill] || [normalizedSkill];
  
  const headers: HeadersInit = {
    'Accept': 'application/vnd.github.v3+json',
  };
  if (GITHUB_TOKEN) {
    headers['Authorization'] = `token ${GITHUB_TOKEN}`;
  }

  let allRepos: GitHubRepo[] = [];
  let page = 1;
  const perPage = 100;
  
  while (page <= 3) {
    const response = await fetch(
      `https://api.github.com/users/${githubUsername}/repos?per_page=${perPage}&page=${page}&sort=updated`,
      { headers }
    );
    
    if (!response.ok) break;
    const repos: GitHubRepo[] = await response.json();
    if (repos.length === 0) break;
    allRepos = [...allRepos, ...repos];
    page++;
  }

  const matchingRepos: any[] = [];
  let totalScore = 0;
  let matchCount = 0;

  for (const repo of allRepos) {
    const readmeResponse = await fetch(
      `https://api.github.com/repos/${repo.full_name}/readme`,
      { headers }
    );
    const hasReadme = readmeResponse.ok;
    
    let hasPackageJson = false;
    if (repo.language) {
      const contentsResponse = await fetch(
        `https://api.github.com/repos/${repo.full_name}/contents/package.json`,
        { headers }
      );
      hasPackageJson = contentsResponse.ok;
    }

    const matchScore = calculateRepoMatchScore(repo, searchTerms, hasReadme, hasPackageJson);
    
    if (matchScore > 0) {
      matchingRepos.push({
        repoName: repo.name,
        repoUrl: repo.html_url,
        stars: repo.stargazers_count,
        forks: repo.forks_count,
        commits: 0,
        languages: repo.language ? [repo.language] : [],
        hasReadme,
        hasPackageJson,
        isFork: repo.fork,
        lastUpdated: repo.updated_at,
        matchScore
      });
      totalScore += matchScore;
      matchCount++;
    }
  }

  if (matchCount === 0) {
    return {
      score: 0,
      level: 'unverified',
      evidence: [],
      confidence: 0
    };
  }

  const avgScore = totalScore / matchCount;
  const repoCountBonus = Math.min(matchCount * 5, 20);
  const finalScore = Math.min(avgScore + repoCountBonus, 100);

  let level = 'unverified';
  if (finalScore >= 90) level = 'expert';
  else if (finalScore >= 70) level = 'verified';
  else if (finalScore >= 40) level = 'partial';

  const confidence = Math.min(matchCount * 15, 85);

  return {
    score: Math.round(finalScore),
    level,
    evidence: matchingRepos.slice(0, 5),
    confidence
  };
}

function calculateRepoMatchScore(
  repo: GitHubRepo, 
  searchTerms: string[], 
  hasReadme: boolean, 
  hasPackageJson: boolean
): number {
  if (repo.fork) return 0;
  if (repo.size < 1) return 0;
  
  const repoName = repo.name.toLowerCase();
  const repoDescription = '';
  
  let score = 0;
  
  for (const term of searchTerms) {
    if (repoName.includes(term)) score += 30;
    if (repoDescription.includes(term)) score += 15;
  }

  if (repo.language && searchTerms.some(t => 
    repo.language?.toLowerCase().includes(t) ||
    t.includes(repo.language?.toLowerCase() || '')
  )) {
    score += 20;
  }

  if (hasReadme) score += 10;
  if (hasPackageJson) score += 15;
  if (repo.stargazers_count > 10) score += 5;
  if (repo.stargazers_count > 50) score += 10;
  if (repo.stargazers_count > 100) score += 15;

  return score;
}

async function processValidationTask(taskId: string) {
  const task = validationQueue.get(taskId);
  if (!task) return;

  task.status = 'processing';
  task.updatedAt = new Date();
  validationQueue.set(taskId, task);

  try {
    const result = await validateSkillWithGitHub(task.skillName, task.githubUsername);
    
    task.status = 'completed';
    task.result = result;
    task.updatedAt = new Date();
  } catch (error) {
    task.status = 'failed';
    task.error = error instanceof Error ? error.message : 'Unknown error';
    task.retryCount++;
    task.updatedAt = new Date();
    
    if (task.retryCount < 3) {
      task.status = 'pending';
    }
  }

  validationQueue.set(taskId, task);
}

function scheduleBackgroundProcessing() {
  setTimeout(async () => {
    for (const [taskId, task] of validationQueue) {
      if (task.status === 'pending') {
        await processValidationTask(taskId);
      }
    }
    scheduleBackgroundProcessing();
  }, 2000);
}

scheduleBackgroundProcessing();

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { skillName, githubUsername, userId } = body;

    if (!skillName || !githubUsername) {
      return NextResponse.json(
        { error: 'skillName and githubUsername are required' },
        { status: 400 }
      );
    }

    const taskId = uuidv4();
    const task: ValidationTask = {
      id: taskId,
      skillName,
      githubUsername,
      userId: userId || 'anonymous',
      status: 'pending',
      createdAt: new Date(),
      updatedAt: new Date(),
      retryCount: 0
    };

    validationQueue.set(taskId, task);

    setTimeout(() => processValidationTask(taskId), 100);

    return NextResponse.json({
      taskId,
      status: 'pending'
    });
  } catch {
    return NextResponse.json(
      { error: 'Failed to create validation task' },
      { status: 500 }
    );
  }
}

export async function GET(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams;
  const taskId = searchParams.get('taskId');

  if (!taskId) {
    return NextResponse.json(
      { error: 'taskId is required' },
      { status: 400 }
    );
  }

  const task = validationQueue.get(taskId);

  if (!task) {
    return NextResponse.json(
      { error: 'Task not found' },
      { status: 404 }
    );
  }

  return NextResponse.json({
    taskId: task.id,
    status: task.status,
    result: task.result,
    error: task.error,
    retryCount: task.retryCount
  });
}