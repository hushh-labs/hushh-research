"use client";

import { ReactNode } from "react";
import { motion } from "framer-motion";
import { cn } from "@/lib/morphy-ux/cn";

interface TemplateProps {
  children: ReactNode;
  className?: string;
}

export default function Template({ children, className }: TemplateProps) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -10 }}
      transition={{ duration: 0.3, ease: "easeInOut" }}
      className={cn("flex-1 flex flex-col min-h-0 w-full", className)}
    >
      {children}
    </motion.div>
  );
}