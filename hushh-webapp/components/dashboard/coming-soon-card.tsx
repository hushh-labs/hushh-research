// components/dashboard/coming-soon-card.tsx
import * as React from 'react';
import { Card, CardHeader, CardTitle, CardDescription, CardContent, Button } from '@/lib/morphy-ux/morphy';
import { LucideIcon, Bell, CheckCircle2 } from 'lucide-react';

interface ComingSoonCardProps {
  title: string;
  description: string;
  icon: LucideIcon;
  color?: string;
}

export function ComingSoonCard({ title, description, icon: Icon, color = 'text-blue-500' }: ComingSoonCardProps) {
  const [isNotified, setIsNotified] = React.useState(false);
  const [isLoading, setIsLoading] = React.useState(false);

  const handleNotify = async () => {
    setIsLoading(true);
    // Simulate API call
    await new Promise((resolve) => setTimeout(resolve, 1000));
    setIsNotified(true);
    setIsLoading(false);
  };

  return (
    <Card className="glass transition-all duration-300 hover:shadow-lg">
      <CardHeader>
        <div className="flex items-center gap-3">
          <div className={`p-2 rounded-xl bg-background/50 border ${color.replace('text-', 'border-').replace('-500', '-500/20')}`}>
            <Icon className={`h-6 w-6 ${color}`} />
          </div>
          <div>
            <CardTitle className="text-xl">{title}</CardTitle>
            <CardDescription className="text-xs uppercase tracking-wider font-semibold">
              Coming Soon
            </CardDescription>
          </div>
        </div>
      </CardHeader>
      
      <CardContent className="space-y-6">
        <p className="text-muted-foreground text-sm leading-relaxed">
          {description}
        </p>
        
        <div className="p-4 bg-muted/30 rounded-lg border border-dashed border-muted-foreground/20">
          <p className="text-xs text-center text-muted-foreground font-medium uppercase tracking-tight">
            🚧 This domain is under active development
          </p>
        </div>

        <Button 
          // Using 'as any' to bypass the strict type definition in morphy-ux
          variant={isNotified ? ("outline" as any) : ("gradient" as any)}
          effect="glass" 
          className="w-full transition-all duration-300" 
          onClick={handleNotify}
          disabled={isNotified || isLoading}
          showRipple={!isNotified}
          aria-label={isNotified ? "Notification enabled" : "Notify me when ready"}
        >
          {isLoading ? (
            "Processing..."
          ) : isNotified ? (
            <span className="flex items-center gap-2">
              <CheckCircle2 className="h-4 w-4" /> Added to Waitlist
            </span>
          ) : (
            <span className="flex items-center gap-2">
              <Bell className="h-4 w-4" /> Notify Me When Ready
            </span>
          )}
        </Button>
      </CardContent>
    </Card>
  );
}