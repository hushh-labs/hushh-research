'use client';

import { useState } from 'react';
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SkillValidationCard } from "@/components/app-ui/surfaces";

interface SkillTask {
  id: string;
  name: string;
  status: 'processing' | 'verified';
}

export default function OnboardingPage() {
  const [tasks, setTasks] = useState<SkillTask[]>([]);
  const [inputValue, setInputValue] = useState("");

  const handleAddSkill = async () => {
    if (!inputValue.trim()) return;

    const skillName = inputValue;
    const skillId = Date.now().toString();

    const newSkill: SkillTask = { id: skillId, name: skillName, status: 'processing' };
    setTasks(prev => [newSkill, ...prev]);
    setInputValue("");

    // Simulate the Hushh Agent working
    setTimeout(() => {
      setTasks(prev => prev.map(t =>
        t.id === skillId ? { ...t, status: 'verified' } : t
      ));
    }, 3000);
  };

  return (
    <div className="max-w-2xl mx-auto p-8 pt-20 min-h-screen bg-black">
      <div className="space-y-8">
        <div className="space-y-2">
          <h1 className="text-3xl font-black text-white italic uppercase">Skill Pipeline</h1>
          <p className="text-white/50 text-sm">Add skills to trigger AI verification via Hushh Research Agent.</p>
        </div>

        <div className="flex gap-3 bg-white/5 p-2 rounded-2xl border border-white/10">
          <Input
            placeholder="Enter Skill (e.g. React, Python)"
            value={inputValue}
            onChange={(e) => setInputValue(e.target.value)}
            className="bg-transparent border-none text-white focus-visible:ring-0"
          />
          <Button onClick={handleAddSkill} className="bg-white text-black font-bold px-6">
            VALIDATE
          </Button>
        </div>

        <div className="space-y-4">
          <>
            {tasks.map((task) => (
              <SkillValidationCard key={task.id} name={task.name} status={task.status} />
            ))}
          </>
        </div>
      </div>
    </div>
  );
}