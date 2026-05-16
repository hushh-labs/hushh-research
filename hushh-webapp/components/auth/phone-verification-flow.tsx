"use client";

import { useRef, useState, KeyboardEvent, ChangeEvent, ClipboardEvent } from "react";
import { Loader2, ShieldCheck } from "lucide-react";
import { Button } from "@/lib/morphy-ux/button";
import { Input } from "@/components/ui/input";

interface PhoneVerificationFlowProps {
  phoneNumber: string;
  onVerify: (code: string) => Promise<void>;
  onResend: () => Promise<void>;
  isLoading?: boolean;
}

export function PhoneVerificationFlow({
  phoneNumber,
  onVerify,
  onResend,
  isLoading = false,
}: PhoneVerificationFlowProps) {
  const [code, setCode] = useState<string[]>(Array(6).fill(""));
  const inputRefs = useRef<(HTMLInputElement | null)[]>([]);

  // FOCUS ROUTING SEMANTICS HARVESTED HERE
  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>, index: number) => {
    if (e.key === "Backspace") {
      if (code[index] === "" && index > 0) {
        inputRefs.current[index - 1]?.focus();
      } else {
        const newCode = [...code];
        newCode[index] = "";
        setCode(newCode);
      }
    } else if (e.key === "ArrowLeft" && index > 0) {
      inputRefs.current[index - 1]?.focus();
    } else if (e.key === "ArrowRight" && index < 5) {
      inputRefs.current[index + 1]?.focus();
    }
  };

  const handleChange = (e: ChangeEvent<HTMLInputElement>, index: number) => {
    const value = e.target.value.replace(/[^0-9]/g, "");
    if (!value) return;

    const newCode = [...code];
    newCode[index] = value.substring(value.length - 1);
    setCode(newCode);

    if (index < 5 && value) {
      inputRefs.current[index + 1]?.focus();
    }
  };

  const handlePaste = (e: ClipboardEvent<HTMLInputElement>) => {
    e.preventDefault();
    const pastedData = e.clipboardData.getData("text/plain").replace(/[^0-9]/g, "").slice(0, 6);
    if (!pastedData) return;

    const newCode = [...code];
    for (let i = 0; i < pastedData.length; i++) {
      newCode[i] = pastedData[i];
    }
    setCode(newCode);
    
    const focusIndex = Math.min(pastedData.length, 5);
    inputRefs.current[focusIndex]?.focus();
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const fullCode = code.join("");
    if (fullCode.length === 6) {
      onVerify(fullCode);
    }
  };

  return (
    <div className="flex flex-col items-center justify-center space-y-6 w-full max-w-sm mx-auto p-6">
      <div className="flex h-12 w-12 items-center justify-center rounded-full bg-primary/10">
        <ShieldCheck className="h-6 w-6 text-primary" />
      </div>
      <div className="text-center space-y-2">
        <h2 className="text-2xl font-semibold tracking-tight">Verify your phone</h2>
        <p className="text-sm text-muted-foreground">
          We sent a 6-digit code to <span className="font-medium text-foreground">{phoneNumber}</span>
        </p>
      </div>

      <form onSubmit={handleSubmit} className="w-full space-y-6">
        <div className="flex justify-between gap-2">
          {code.map((digit, idx) => (
            <Input
              key={idx}
              ref={(el) => {
                inputRefs.current[idx] = el;
              }}
              type="text"
              inputMode="numeric"
              pattern="[0-9]*"
              maxLength={1}
              value={digit || ""}
              onChange={(e) => handleChange(e, idx)}
              onKeyDown={(e) => handleKeyDown(e, idx)}
              onPaste={idx === 0 ? handlePaste : undefined}
              className="h-12 w-12 text-center text-lg font-semibold sm:h-14 sm:w-14"
              disabled={isLoading}
              autoFocus={idx === 0}
              aria-label={`Digit ${idx + 1} of 6`}
            />
          ))}
        </div>

        <Button 
          type="submit" 
          className="w-full" 
          disabled={code.join("").length !== 6 || isLoading}
        >
          {isLoading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
          Verify Code
        </Button>
      </form>

      <Button variant="none" size="sm" onClick={onResend} disabled={isLoading} className="text-muted-foreground">
        Didn't receive a code? Resend
      </Button>
    </div>
  );
}