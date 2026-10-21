import type { Metadata } from "next";
import Script from "next/script";
import { cookies } from "next/headers";
import type { ReactNode } from "react";
import { AppearanceProvider } from "@/components/appearance-provider";
import { ShellIconSprite } from "@/components/shell-icon-sprite";
import { FloatingInquiryLoader } from "@/components/floating-inquiry-loader";
import { englishUiMessages, englishUiUrl } from "@/lib/ui-dictionary-server";
import "./globals.css";
import "./appearance.css";

export const metadata: Metadata = {
  title: "AI Project OS",
  description: "通过自动抽取、语义记忆、引用式问答与只读项目智能体，建立可追溯、可审阅的项目长期记忆。",
};

const appearanceBootstrap = `
(() => {
  try {
    const values = Object.fromEntries(document.cookie.split(';').map((entry) => {
      const index = entry.indexOf('=');
      return index < 0 ? ['', ''] : [entry.slice(0, index).trim(), decodeURIComponent(entry.slice(index + 1).trim())];
    }));
    const language = values['aipos-language'] === 'en' ? 'en' : 'zh-CN';
    const preference = ['light', 'dark', 'system'].includes(values['aipos-theme']) ? values['aipos-theme'] : 'light';
    const systemDark = preference === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches;
    const theme = preference === 'dark' || systemDark ? 'dark' : 'light';
    document.documentElement.lang = language;
    document.documentElement.dataset.language = language;
    document.documentElement.dataset.themePreference = preference;
    document.documentElement.dataset.theme = theme;
  } catch (_) {
    document.documentElement.dataset.themePreference = 'light';
    document.documentElement.dataset.theme = 'light';
  }
})();
`;

export default async function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  const preferences = await cookies();
  const language = preferences.get("aipos-language")?.value === "en" ? "en" : "zh-CN";
  const rawTheme = preferences.get("aipos-theme")?.value;
  const theme = rawTheme === "dark" || rawTheme === "system" ? rawTheme : "light";
  return (
    <html lang={language} data-language={language} data-theme={theme === "dark" ? "dark" : "light"} data-theme-preference={theme} className="h-full antialiased" suppressHydrationWarning>
      <body className="min-h-full flex flex-col">
        <ShellIconSprite />
        <Script id="appearance-bootstrap" strategy="beforeInteractive">{appearanceBootstrap}</Script>
        <AppearanceProvider initialLanguage={language} initialTheme={theme} initialMessages={language === "en" ? englishUiMessages : null} dictionaryUrl={englishUiUrl}>
          {children}
          <FloatingInquiryLoader />
        </AppearanceProvider>
      </body>
    </html>
  );
}
