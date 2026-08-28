import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: "AI Project OS · Project Intelligence V2.3.0",
  description: "通过自动抽取、语义记忆、引用式问答与只读项目智能体，建立可追溯、可审阅的项目长期记忆。",
};

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="zh-CN" className="h-full antialiased">
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
