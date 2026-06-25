// components/dashboard/coming-soon-card.tsx

import { Card, CardHeader, CardTitle, CardDescription, CardContent, Button } from '@/lib/morphy-ux/morphy';
import { LucideIcon } from 'lucide-react';

interface ComingSoonCardProps {
  title: string;
  description: string;
  icon: LucideIcon;
  color?: string;
}

export function ComingSoonCard({ title, description, icon: Icon, color = 'text-blue-500' }: ComingSoonCardProps) {
  return (
    <Card className="glass">
      <CardHeader>
        <div className="flex items-center gap-3">
          <Icon className={`h-8 w-8 ${color}`} />
          <div>
            <CardTitle>{title}</CardTitle>
            <CardDescription>Coming Soon</CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-muted-foreground">
          {description}
        </p>
        <div className="p-4 bg-muted/50 rounded-lg border border-dashed">
          <p className="text-sm text-center text-muted-foreground">
            🚧 This domain is under development
          </p>
        </div>
        <Button type="button" variant="gradient" effect="glass" className="w-full" disabled showRipple>
          Notify Me When Ready
        </Button>
      </CardContent>
    </Card>
  );
}
