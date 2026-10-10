import type { Metadata } from "next";
import { Be_Vietnam_Pro, Space_Grotesk } from "next/font/google";
import { InlineScript } from "@/components/InlineScript";
import { Providers } from "@/components/Providers";
import "./globals.css";

const beVietnamPro = Be_Vietnam_Pro({
  variable: "--font-sans",
  subsets: ["latin", "vietnamese"],
  weight: ["400", "500", "600", "700"],
  display: "swap",
});

const spaceGrotesk = Space_Grotesk({
  variable: "--font-display",
  subsets: ["latin"],
  display: "swap",
});

// Runs before React hydrates so the theme is applied before first paint.
// Must match components/theme/ThemeProvider.tsx (THEME_STORAGE_KEY).
// Preference: localStorage "bsja_theme" = "light" | "dark" | "system" (default).
const NO_FLASH_THEME_SCRIPT = `(function(){try{var p=localStorage.getItem('bsja_theme')||'system';var d=p==='dark'||(p==='system'&&window.matchMedia('(prefers-color-scheme: dark)').matches);var t=d?'dark':'light';document.documentElement.setAttribute('data-theme',t);document.documentElement.style.colorScheme=t;}catch(e){document.documentElement.setAttribute('data-theme','light');}})();`;

export const metadata: Metadata = {
  title: {
    template: "%s | bs-job-agents",
    default: "bs-job-agents",
  },
  description: "Local multi-bot job search and apply crew.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html
      lang="en"
      data-theme="light"
      suppressHydrationWarning
      className={`${beVietnamPro.variable} ${spaceGrotesk.variable}`}
    >
      <head>
        <InlineScript html={NO_FLASH_THEME_SCRIPT} />
      </head>
      <body className="min-h-dvh antialiased">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
