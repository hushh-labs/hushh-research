import { useState, useCallback } from "react";
import { toast } from "sonner"; // Assuming sonner is used for toasts, if not I'll just use state

export function useCopy(timeout = 2000) {
  const [isCopied, setIsCopied] = useState(false);

  const copyToClipboard = useCallback(
    async (text: string, successMessage?: string) => {
      if (!text) return false;

      try {
        if (navigator.clipboard && window.isSecureContext) {
          await navigator.clipboard.writeText(text);
        } else {
          // Fallback for older browsers
          const textArea = document.createElement("textarea");
          textArea.value = text;
          textArea.style.position = "absolute";
          textArea.style.left = "-999999px";
          document.body.prepend(textArea);
          textArea.select();
          try {
            document.execCommand("copy");
          } catch (error) {
            console.error("Fallback copy failed", error);
            return false;
          } finally {
            textArea.remove();
          }
        }

        setIsCopied(true);
        if (successMessage) {
          toast.success(successMessage);
        }
        
        setTimeout(() => {
          setIsCopied(false);
        }, timeout);

        return true;
      } catch (error) {
        console.error("Failed to copy text", error);
        toast.error("Failed to copy to clipboard");
        return false;
      }
    },
    [timeout]
  );

  return { isCopied, copyToClipboard };
}
