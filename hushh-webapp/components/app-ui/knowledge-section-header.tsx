import type { LucideIcon } from "@/components/icons";

/** Supporting section beneath the public workspace's shared title and tabs. */
export function KnowledgeSectionHeader({ title, description, icon: Icon, tone = "blue" }: {
  title: string;
  description: string;
  icon: LucideIcon;
  tone?: "blue" | "purple" | "green";
}) {
  const tones = {
    blue: "bg-blue-500/10 text-blue-500",
    purple: "bg-purple-500/10 text-purple-500",
    green: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
  };
  return (
    <header className="flex items-center gap-3 rounded-[var(--app-card-radius-standard)] bg-[color:var(--app-card-surface-default-solid)] p-4">
      <span className={`flex size-10 shrink-0 items-center justify-center rounded-[12px] ${tones[tone]}`}>
        <Icon className="size-5" aria-hidden="true" />
      </span>
      <div className="min-w-0">
        <h2 className="text-[17px] font-semibold leading-6 tracking-[-0.02em]">{title}</h2>
        <p className="mt-0.5 text-[14px] leading-5 text-muted-foreground">{description}</p>
      </div>
    </header>
  );
}
