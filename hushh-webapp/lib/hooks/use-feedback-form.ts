import { create } from "zustand";
import { toast } from "sonner";

interface FeedbackState {
  isOpen: boolean;
  isSubmitting: boolean;
  type: "bug" | "feature" | "general";
  message: string;
  setIsOpen: (isOpen: boolean) => void;
  setType: (type: "bug" | "feature" | "general") => void;
  setMessage: (message: string) => void;
  submitFeedback: () => Promise<void>;
  reset: () => void;
}

export const useFeedbackForm = create<FeedbackState>((set, get) => ({
  isOpen: false,
  isSubmitting: false,
  type: "bug",
  message: "",
  
  setIsOpen: (isOpen) => set({ isOpen }),
  setType: (type) => set({ type }),
  setMessage: (message) => set({ message }),
  
  reset: () => set({ type: "bug", message: "", isSubmitting: false }),
  
  submitFeedback: async () => {
    const { message } = get();
    
    if (!message.trim()) {
      toast.error("Please enter a message");
      return;
    }

    set({ isSubmitting: true });

    try {
      // Simulate API call to feedback backend
      await new Promise(resolve => setTimeout(resolve, 800));
      
      toast.success("Feedback submitted! Thank you.");
      set({ isOpen: false, message: "", type: "bug", isSubmitting: false });
    } catch (error) {
      console.error("Feedback submission error:", error);
      toast.error("Failed to submit feedback. Please try again.");
      set({ isSubmitting: false });
    }
  }
}));
