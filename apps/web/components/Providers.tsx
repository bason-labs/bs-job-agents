"use client";

import type { ReactNode } from "react";
import { ThemeProvider } from "@/components/theme/ThemeProvider";
import { FileViewerProvider } from "@/components/ui/FileViewer";
import { ToastProvider } from "@/components/ui/Toast";
import { TooltipProvider } from "@/components/ui/Tooltip";

/** App-wide client providers: theme, tooltips, toasts, file viewer. */
export function Providers({ children }: { children: ReactNode }) {
  return (
    <ThemeProvider>
      <TooltipProvider delayDuration={250}>
        <ToastProvider>
          <FileViewerProvider>{children}</FileViewerProvider>
        </ToastProvider>
      </TooltipProvider>
    </ThemeProvider>
  );
}
