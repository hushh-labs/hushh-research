import { cn } from "@/lib/utils";
import { CHAT_WELCOME_COPY_CLASSNAME } from "./chat-message-styles";
import { AgentSuggestionList } from "./agent-follow-up-suggestions";

export function AgentPromptSuggestions({
  prompts,
  disabled,
  onPromptSelect,
}: {
  prompts: readonly string[];
  disabled: boolean;
  onPromptSelect: (prompt: string) => void;
}) {
  return (
    <AgentSuggestionList suggestions={prompts} disabled={disabled} layout="starter-grid"
      label="Suggestions" testId="agent-chat-suggestions" onSelect={onPromptSelect} />
  );
}

export function AgentWelcomePanel({
  name,
  prompts,
  disabled,
  onPromptSelect,
}: {
  name: string;
  prompts: readonly string[];
  disabled: boolean;
  onPromptSelect: (prompt: string) => void;
}) {
  return (
    // Keep the greeting close to the header; viewport-height centering creates
    // an increasingly large gap on taller screens.
    <section className="flex flex-col pb-2 pt-2">
      <div className="mx-auto flex w-full max-w-2xl flex-col items-start px-1 text-left sm:px-2">
        <h2 data-profile-role="identity-name" className="max-w-full break-words text-foreground [overflow-wrap:anywhere]">
          Hi {name}
        </h2>
        <p data-profile-role="header-description" className={cn("mt-2 max-w-xl", CHAT_WELCOME_COPY_CLASSNAME)}>
          What would you like to do today?
        </p>
        <AgentPromptSuggestions
          prompts={prompts}
          disabled={disabled}
          onPromptSelect={onPromptSelect}
        />
      </div>
    </section>
  );
}

