'use client';

import { useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { 
  VerificationLevel, 
  GitHubEvidence,
  getVerificationLevel,
  getVerificationLabel 
} from '@/lib/types/skill-validation';
import { SkillValidationService } from '@/lib/services/skill-validation-service';

interface Skill {
  name: string;
  isVerified: boolean;
  verificationScore?: number;
  verificationLevel?: VerificationLevel;
  githubEvidence?: GitHubEvidence[];
  githubUsername?: string;
}

interface SkillVerifierProps {
  initialSkills?: Skill[];
  onSkillsChange?: (skills: Skill[]) => void;
}

export function SkillVerifier({ initialSkills = [], onSkillsChange }: SkillVerifierProps) {
  const [skills, setSkills] = useState<Skill[]>(initialSkills);
  const [newSkill, setNewSkill] = useState('');
  const [githubUsername, setGithubUsername] = useState('');
  const [isValidating, setIsValidating] = useState(false);
  const [error, setError] = useState('');
  const [validatingSkill, setValidatingSkill] = useState<string | null>(null);

  const handleAddSkill = () => {
    if (!newSkill.trim()) return;
    
    const skill: Skill = {
      name: newSkill.trim(),
      isVerified: false,
      githubUsername: githubUsername.trim()
    };
    
    const updatedSkills = [...skills, skill];
    setSkills(updatedSkills);
    onSkillsChange?.(updatedSkills);
    setNewSkill('');
  };

  const handleRemoveSkill = (index: number) => {
    const updatedSkills = skills.filter((_, i) => i !== index);
    setSkills(updatedSkills);
    onSkillsChange?.(updatedSkills);
  };

  const handleVerifySkill = async (index: number) => {
    const skill = skills[index];
    if (!skill?.githubUsername) {
      setError('GitHub username is required for verification');
      return;
    }

    setValidatingSkill(skill.name);
    setIsValidating(true);
    setError('');

    try {
      const pollResult = await SkillValidationService.validateSkill({
        skillName: skill.name,
        githubUsername: skill.githubUsername,
      });
      
      const updatedSkills = [...skills];
      updatedSkills[index] = {
        ...skill,
        isVerified: pollResult.status === 'completed',
        verificationScore: pollResult.result?.score,
        verificationLevel: pollResult.result?.level 
          ? getVerificationLevel(pollResult.result.score)
          : undefined,
        githubEvidence: pollResult.result?.evidence,
      };
      
      setSkills(updatedSkills);
      onSkillsChange?.(updatedSkills);

      if (pollResult.status === 'failed') {
        setError(pollResult.error || 'Verification failed');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Verification failed');
    } finally {
      setIsValidating(false);
      setValidatingSkill(null);
    }
  };

  const getBadgeVariant = (level?: VerificationLevel) => {
    switch (level) {
      case 'expert':
        return 'bg-purple-600 text-white';
      case 'verified':
        return 'bg-green-600 text-white';
      case 'partial':
        return 'bg-yellow-500 text-white';
      case 'unverified':
        return 'bg-gray-400 text-white';
      default:
        return 'bg-gray-400 text-white';
    }
  };

  const getScoreColor = (score?: number) => {
    if (score === undefined) return 'text-gray-400';
    if (score >= 90) return 'text-purple-600';
    if (score >= 70) return 'text-green-600';
    if (score >= 40) return 'text-yellow-600';
    return 'text-gray-500';
  };

  return (
    <Card className="w-full">
      <CardHeader>
        <CardTitle>Skills</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex gap-2">
          <Input
            placeholder="Add a skill..."
            value={newSkill}
            onChange={(e) => setNewSkill(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleAddSkill()}
          />
          <Input
            placeholder="GitHub username"
            value={githubUsername}
            onChange={(e) => setGithubUsername(e.target.value)}
            className="w-40"
          />
          <Button onClick={handleAddSkill} variant="secondary">
            Add
          </Button>
        </div>

        {error && (
          <p className="text-red-500 text-sm">{error}</p>
        )}

        <div className="space-y-2">
          {skills.map((skill, index) => (
            <div 
              key={index} 
              className="flex items-center justify-between p-3 border rounded-lg"
            >
              <div className="flex-1">
                <div className="flex items-center gap-2">
                  <span className="font-medium">{skill.name}</span>
                  {skill.verificationLevel && (
                    <Badge className={getBadgeVariant(skill.verificationLevel)}>
                      {getVerificationLabel(skill.verificationLevel)}
                    </Badge>
                  )}
                  {skill.verificationScore !== undefined && (
                    <span className={`text-sm font-bold ${getScoreColor(skill.verificationScore)}`}>
                      {skill.verificationScore}%
                    </span>
                  )}
                </div>
                {skill.githubUsername && (
                  <p className="text-sm text-gray-500">@{skill.githubUsername}</p>
                )}
              </div>
              
              <div className="flex gap-2">
                {skill.isVerified ? (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => handleVerifySkill(index)}
                    disabled={isValidating}
                  >
                    Re-verify
                  </Button>
                ) : (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => handleVerifySkill(index)}
                    disabled={isValidating || !skill.githubUsername}
                  >
                    {validatingSkill === skill.name && isValidating 
                      ? 'Validating...' 
                      : 'Verify'}
                  </Button>
                )}
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => handleRemoveSkill(index)}
                >
                  ×
                </Button>
              </div>
            </div>
          ))}

          {skills.length === 0 && (
            <p className="text-gray-500 text-center py-4">
              No skills added yet
            </p>
          )}
        </div>
      </CardContent>
    </Card>
  );
}