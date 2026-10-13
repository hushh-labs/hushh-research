/**
 * useStreamingText Hook
 *
 * A performance-optimized hook for handling streaming text from SSE/WebSocket.
 * Uses token buffering to prevent excessive re-renders during high-frequency streams.
 *
 * Based on ChatGPT/Perplexity streaming patterns.
 *
 * @example
 * const { displayedText, isStreaming, addToken, startStreaming, completeStreaming } = useStreamingText();
 *
 * // In SSE handler:
 * eventSource.onmessage = (e) => {
 *   const data = JSON.parse(e.data);
 *   addToken(data.text);
 * };
 */

import { useState, useRef, useEffect, useCallback } from "react";

export interface UseStreamingTextOptions {
  /** Batch interval in ms (default: 50ms) - how often to flush buffer to state */
  batchInterval?: number;
  /** Callback when streaming completes */
  onComplete?: () => void;
  /** Initial text to display */
  initialText?: string;
}

export interface UseStreamingTextReturn {
  /** The text currently displayed (batched from buffer) */
  displayedText: string;
  /** Whether streaming is active */
  isStreaming: boolean;
  /** Add a token/chunk to the buffer (call from SSE handler) */
  addToken: (token: string) => void;
  /** Start streaming (resets state) */
  startStreaming: () => void;
  /** Complete streaming (flushes buffer, sets isStreaming false) */
  completeStreaming: () => void;
  /** Directly set displayed text (for non-streaming updates) */
  setDisplayedText: React.Dispatch<React.SetStateAction<string>>;
  /** Reset to initial state */
  reset: () => void;
  /** Get current buffer length (for progress tracking) */
  getBufferLength: () => number;
}

export function useStreamingText(
  options: UseStreamingTextOptions = {}
): UseStreamingTextReturn {
  const { batchInterval = 50, onComplete, initialText = "" } = options;

  const [displayedText, setDisplayedText] = useState(initialText);
  const [isStreaming, setIsStreaming] = useState(false);

  // Buffer tokens in ref to avoid re-renders on each token
  const bufferRef = useRef<string>("");
  const intervalRef = useRef<NodeJS.Timeout | null>(null);
  const totalCharsRef = useRef<number>(0);

  // Flush buffer to state
  const flushBuffer = useCallback(() => {
    if (bufferRef.current) {
      setDisplayedText((prev) => prev + bufferRef.current);
      bufferRef.current = "";
    }
  }, []);

  // Start batching - flush buffer at regular intervals
  const startBatching = useCallback(() => {
    if (intervalRef.current) return;

    intervalRef.current = setInterval(() => {
      flushBuffer();
    }, batchInterval);
  }, [batchInterval, flushBuffer]);

  // Stop batching and flush remaining buffer
  const stopBatching = useCallback(() => {
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
    flushBuffer();
  }, [flushBuffer]);

  // Add token to buffer (call this from SSE handler)
  const addToken = useCallback((token: string) => {
    bufferRef.current += token;
    totalCharsRef.current += token.length;
  }, []);

  // Start streaming
  const startStreaming = useCallback(() => {
    setDisplayedText("");
    bufferRef.current = "";
    totalCharsRef.current = 0;
    setIsStreaming(true);
    startBatching();
  }, [startBatching]);

  // Complete streaming
  const completeStreaming = useCallback(() => {
    stopBatching();
    setIsStreaming(false);
    onComplete?.();
  }, [stopBatching, onComplete]);

  // Reset to initial state
  const reset = useCallback(() => {
    stopBatching();
    setDisplayedText(initialText);
    bufferRef.current = "";
    totalCharsRef.current = 0;
    setIsStreaming(false);
  }, [stopBatching, initialText]);

  // Get current buffer length
  const getBufferLength = useCallback(() => {
    return totalCharsRef.current;
  }, []);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
      }
    };
  }, []);

  return {
    displayedText,
    isStreaming,
    addToken,
    startStreaming,
    completeStreaming,
    setDisplayedText,
    reset,
    getBufferLength,
  };
}
