import { useEffect, useState } from "react";

const SCRATCHPAD_STORAGE_KEY = "hushh_scratchpad_content";
const SCRATCHPAD_OPEN_KEY = "hushh_scratchpad_is_open";

export function useScratchpad() {
  const [content, setContent] = useState<string>("");
  const [isOpen, setIsOpen] = useState<boolean>(false);
  const [isInitialized, setIsInitialized] = useState(false);

  // Load initial state from localStorage
  useEffect(() => {
    try {
      const savedContent = localStorage.getItem(SCRATCHPAD_STORAGE_KEY);
      const savedIsOpen = localStorage.getItem(SCRATCHPAD_OPEN_KEY);
      
      if (savedContent) setContent(savedContent);
      if (savedIsOpen === "true") setIsOpen(true);
    } catch (e) {
      console.error("Failed to load scratchpad state from localStorage", e);
    } finally {
      setIsInitialized(true);
    }
  }, []);

  // Sync content to localStorage
  const updateContent = (newContent: string) => {
    setContent(newContent);
    try {
      localStorage.setItem(SCRATCHPAD_STORAGE_KEY, newContent);
    } catch (e) {
      console.error("Failed to save scratchpad content", e);
    }
  };

  // Sync open state to localStorage
  const toggleOpen = () => {
    setIsOpen((prev) => {
      const nextState = !prev;
      try {
        localStorage.setItem(SCRATCHPAD_OPEN_KEY, String(nextState));
      } catch (e) {
        console.error("Failed to save scratchpad open state", e);
      }
      return nextState;
    });
  };

  const closeScratchpad = () => {
    setIsOpen(false);
    try {
      localStorage.setItem(SCRATCHPAD_OPEN_KEY, "false");
    } catch (e) {
      console.error("Failed to save scratchpad open state", e);
    }
  };

  return {
    content,
    isOpen,
    isInitialized,
    updateContent,
    toggleOpen,
    closeScratchpad,
  };
}
