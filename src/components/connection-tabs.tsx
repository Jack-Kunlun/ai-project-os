import Link from "next/link";

export function ConnectionTabs({ active }: { active: "git" | "mcp" }) {
  return (
    <nav className="mt-6 flex w-fit max-w-full items-center gap-1 overflow-x-auto rounded-2xl border border-slate-200 bg-white p-1 shadow-sm" aria-label="连接器类型">
      <Link href="/connections" aria-current={active === "git" ? "page" : undefined} className={`flex min-h-11 shrink-0 items-center justify-center rounded-xl px-5 py-2 text-sm font-semibold transition ${active === "git" ? "bg-slate-950 text-white" : "text-slate-500 hover:bg-slate-100 hover:text-slate-900"}`}>Git 代码来源</Link>
      <Link href="/connections/mcp" aria-current={active === "mcp" ? "page" : undefined} className={`flex min-h-11 shrink-0 items-center justify-center rounded-xl px-5 py-2 text-sm font-semibold transition ${active === "mcp" ? "bg-slate-950 text-white" : "text-slate-500 hover:bg-slate-100 hover:text-slate-900"}`}>MCP 只读工具</Link>
    </nav>
  );
}
