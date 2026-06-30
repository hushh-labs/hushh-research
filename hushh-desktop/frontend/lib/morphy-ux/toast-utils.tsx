"use client";

import { toast } from "sonner";
import { type ColorVariant, type FeedbackTone } from "./types";
import {
  CheckCircleIcon,
  InfoIcon,
  WarningIcon,
  XCircleIcon,
  SparkleIcon,
} from "@phosphor-icons/react";
import { useIconWeight } from "./icon-theme-context";
import { cn } from "@/lib/utils";

type MorphyToastTone = FeedbackTone | "danger";

function toSonnerTone(tone: MorphyToastTone): FeedbackTone {
  return tone === "danger" ? "error" : tone;
}

// ============================================================================
// GLOBAL TOAST PERSISTENCE SYSTEM
// ============================================================================

// Toast options interface for persisted toasts (routing-safe)
interface PersistentToastOptions {
  duration?: number;
  action?: {
    label: string;
    onClick: () => void;
  };
  onDismiss?: () => void;
  onAutoClose?: () => void;
  className?: string;
  description?: string;
}

interface PersistentToast {
  id: string;
  type: MorphyToastTone;
  message: string;
  duration?: number;
  options?: PersistentToastOptions;
  timestamp: number;
}

class GlobalToastManager {
  private static instance: GlobalToastManager;
  private pendingToasts: PersistentToast[] = [];
  private isInitialized = false;
  /** In-memory store replacing sessionStorage */
  private store: PersistentToast[] = [];

  static getInstance(): GlobalToastManager {
    if (!GlobalToastManager.instance) {
      GlobalToastManager.instance = new GlobalToastManager();
    }
    return GlobalToastManager.instance;
  }

  initialize() {
    if (this.isInitialized) return;

    // Load any pending toasts from in-memory store
    this.loadPendingToasts();

    // Show pending toasts
    this.showPendingToasts();

    this.isInitialized = true;
  }

  private loadPendingToasts() {
    if (typeof window === "undefined") return;

    try {
      if (this.store.length > 0) {
        // Only keep toasts from the last 30 seconds to avoid showing stale toasts
        const now = Date.now();
        this.pendingToasts = this.store.filter(
          (toast) => now - toast.timestamp < 30000
        );
        // Clear the stored toasts
        this.store = [];
      }
    } catch (error) {
      console.warn("Failed to load pending toasts:", error);
      this.store = [];
    }
  }

  private showPendingToasts() {
    this.pendingToasts.forEach((toastData) => {
      setTimeout(() => {
        this.showToast(toastData.type, toastData.message, toastData.options);
      }, 100); // Small delay to ensure DOM is ready
    });
    this.pendingToasts = [];
  }

  private showToast(
    type: MorphyToastTone,
    message: string,
    options?: PersistentToastOptions
  ) {
    switch (toSonnerTone(type)) {
      case "success":
        toast.success(message, options);
        break;
      case "error":
        toast.error(message, options);
        break;
      case "warning":
        toast.warning(message, options);
        break;
      case "info":
        toast.info(message, options);
        break;
    }
  }

  // Public methods for persistent toasts
  persistToast(
    type: MorphyToastTone,
    message: string,
    options?: PersistentToastOptions
  ) {
    if (typeof window === "undefined") return;

    const persistentToast: PersistentToast = {
      id: `toast-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      type,
      message,
      duration: options?.duration,
      options,
      timestamp: Date.now(),
    };

    // If we're initialized, show immediately
    if (this.isInitialized) {
      this.showToast(type, message, options);
    } else {
      // Otherwise, store in memory for later
      this.pendingToasts.push(persistentToast);
      this.store = [...this.pendingToasts];
    }
  }
}

// Export singleton instance
export const globalToastManager = GlobalToastManager.getInstance();

// ============================================================================
// ENHANCED TOAST UTILITIES WITH MORPHY-UI INTEGRATION
// ============================================================================

interface ToastOptions {
  variant?: ColorVariant;
  duration?: number;
  description?: string;
  className?: string;
}

const getToastVariantAccentClassName = (variant?: ColorVariant) => {
  if (!variant) return undefined;
  return `morphy-sonner-accent-${variant}`;
};

const getToastToneClassName = (
  tone: MorphyToastTone,
  variant?: ColorVariant
) =>
  cn(
    "morphy-sonner-toast",
    `morphy-sonner-tone-${tone}`,
    tone === "danger" ? "morphy-sonner-tone-error" : undefined,
    getToastVariantAccentClassName(variant)
  );

// ============================================================================
// TOAST FUNCTIONS WITH MORPHY-UI VARIANTS
// ============================================================================

// Initialize the global toast manager when this module is imported
if (typeof window !== "undefined") {
  globalToastManager.initialize();
}

export const useMorphyToast = () => {
  const iconWeight = useIconWeight();

  const success = (message: string, options: ToastOptions = {}) => {
    const { variant, duration = 3000, description, className } = options;

    return toast.success(message, {
      duration,
      description,
      icon: (
        <CheckCircleIcon
          className="h-4 w-4 text-current"
          weight={iconWeight}
        />
      ),
      className: cn(getToastToneClassName("success", variant), className),
    });
  };

  const error = (message: string, options: ToastOptions = {}) => {
    const { variant, duration = 5000, description, className } = options;

    return toast.error(message, {
      duration,
      description,
      icon: (
        <XCircleIcon
          className="h-4 w-4 text-current"
          weight={iconWeight}
        />
      ),
      className: cn(getToastToneClassName("error", variant), className),
    });
  };

  const danger = (message: string, options: ToastOptions = {}) => {
    const { variant, duration = 5000, description, className } = options;

    return toast.error(message, {
      duration,
      description,
      icon: (
        <XCircleIcon
          className="h-4 w-4 text-current"
          weight={iconWeight}
        />
      ),
      className: cn(getToastToneClassName("danger", variant), className),
    });
  };

  const warning = (message: string, options: ToastOptions = {}) => {
    const { variant, duration = 4000, description, className } = options;

    return toast.warning(message, {
      duration,
      description,
      icon: (
        <WarningIcon
          className="h-4 w-4 text-current"
          weight={iconWeight}
        />
      ),
      className: cn(getToastToneClassName("warning", variant), className),
    });
  };

  const info = (message: string, options: ToastOptions = {}) => {
    const { variant, duration = 4000, description, className } = options;

    return toast.info(message, {
      duration,
      description,
      icon: (
        <InfoIcon
          className="h-4 w-4 text-current"
          weight={iconWeight}
        />
      ),
      className: cn(getToastToneClassName("info", variant), className),
    });
  };

  const custom = (
    message: string,
    options: ToastOptions & { icon?: React.ReactNode } = {}
  ) => {
    const {
      variant,
      duration = 4000,
      description,
      icon,
      className,
    } = options;

    return toast(message, {
      duration,
      description,
      icon: icon || (
        <SparkleIcon
          className="h-4 w-4 text-current"
          weight={iconWeight}
        />
      ),
      className: cn(
        "morphy-sonner-toast",
        getToastVariantAccentClassName(variant),
        className
      ),
    });
  };

  // Persistent versions that survive page navigation
  const persistentSuccess = (message: string, options: ToastOptions = {}) => {
    globalToastManager.persistToast("success", message, options);
  };

  const persistentError = (message: string, options: ToastOptions = {}) => {
    globalToastManager.persistToast("error", message, options);
  };

  const persistentDanger = (message: string, options: ToastOptions = {}) => {
    globalToastManager.persistToast("danger", message, options);
  };

  const persistentWarning = (message: string, options: ToastOptions = {}) => {
    globalToastManager.persistToast("warning", message, options);
  };

  const persistentInfo = (message: string, options: ToastOptions = {}) => {
    globalToastManager.persistToast("info", message, options);
  };

  return {
    success,
    error,
    danger,
    warning,
    info,
    custom,
    dismiss: toast.dismiss,
    promise: toast.promise,
    // Persistent versions
    persistentSuccess,
    persistentError,
    persistentDanger,
    persistentWarning,
    persistentInfo,
  };
};

// ============================================================================
// CONVENIENCE FUNCTIONS
// ============================================================================

export const morphyToast = {
  success: (message: string, options?: ToastOptions) => {
    const { variant, duration = 3000, description, className } = options || {};

    return toast.success(message, {
      duration,
      description,
      className: cn(getToastToneClassName("success", variant), className),
    });
  },

  error: (message: string, options?: ToastOptions) => {
    const { variant, duration = 5000, description, className } = options || {};

    return toast.error(message, {
      duration,
      description,
      className: cn(getToastToneClassName("error", variant), className),
    });
  },

  danger: (message: string, options?: ToastOptions) => {
    const { variant, duration = 5000, description, className } = options || {};

    return toast.error(message, {
      duration,
      description,
      className: cn(getToastToneClassName("danger", variant), className),
    });
  },

  warning: (message: string, options?: ToastOptions) => {
    const { variant, duration = 4000, description, className } = options || {};

    return toast.warning(message, {
      duration,
      description,
      className: cn(getToastToneClassName("warning", variant), className),
    });
  },

  info: (message: string, options?: ToastOptions) => {
    const { variant, duration = 4000, description, className } = options || {};

    return toast.info(message, {
      duration,
      description,
      className: cn(getToastToneClassName("info", variant), className),
    });
  },

  custom: (
    message: string,
    options?: ToastOptions & { icon?: React.ReactNode }
  ) => {
    const {
      variant,
      duration = 4000,
      description,
      icon,
      className,
    } = options || {};

    return toast(message, {
      duration,
      description,
      icon,
      className: cn(
        "morphy-sonner-toast",
        getToastVariantAccentClassName(variant),
        className
      ),
    });
  },

  dismiss: toast.dismiss,
  promise: toast.promise,
};
