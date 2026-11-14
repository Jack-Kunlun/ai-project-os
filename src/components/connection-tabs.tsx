import Link from "next/link";

export function ConnectionTabs({ active }: { active: "git" | "mcp" }) {
  return (
    <nav className="mt-6 flex w-fit max-w-full items-center gap-1 overflow-x-auto app-panel p-1 " aria-label="连接器类型">
      <Link href="/admin/connectors/git" aria-current={active === "git" ? "page" : undefined} className={`flex min-h-11 shrink-0 items-center justify-center rounded-control px-5 py-2 text-sm font-semibold transition ${active === "git" ? "bg-app-accent text-white" : "text-app-muted hover:bg-app-surface-soft hover:text-app-text"}`}>Git 代码来源</Link>
      <Link href="/admin/connectors/mcp" aria-current={active === "mcp" ? "page" : undefined} className={`flex min-h-11 shrink-0 items-center justify-center rounded-control px-5 py-2 text-sm font-semibold transition ${active === "mcp" ? "bg-app-accent text-white" : "text-app-muted hover:bg-app-surface-soft hover:text-app-text"}`}>MCP 只读工具</Link>
    </nav>
  );
}
