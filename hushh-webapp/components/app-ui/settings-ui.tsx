export function SettingsGroup({
  title,
  eyebrow,
  children,
  className,
  embedded,
  description,
  trailing,
  ...props
}: SettingsGroupProps) {
  return (
    <section className={cn("space-y-3 pt-2", embedded && "pt-0", className)} {...props}>
      {/* Rectified: Using h3 with specific classes for accessibility and inline alignment */}
      <h3 role="heading" aria-level={3} className="text-xs font-bold uppercase flex items-center gap-x-2">
        {eyebrow && (
          <span className="tracking-[0.22em] opacity-75 text-[10px] font-medium bg-muted px-1.5 py-0.5 rounded-md">
            {eyebrow}
          </span>
        )}
        <span className="truncate">{title}</span>
      </h3>
      
      {description && <p className="text-sm text-muted-foreground">{description}</p>}
      
      <div className={cn(
        "rounded-[20px] border border-border/60 bg-card p-1 divide-y divide-border/40 overflow-hidden shadow-sm",
        embedded && "border-none bg-transparent shadow-none"
      )}>
        {children}
      </div>
    </section>
  );
}