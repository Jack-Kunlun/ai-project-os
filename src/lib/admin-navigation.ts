/** Presentation-only destinations; every page keeps its existing server guard. */
type AdminNavigationItem = Readonly<{ label: string; href: string; icon: string }>;
export const adminNavigationGroups: ReadonlyArray<Readonly<{ key: string; label: string; links: readonly AdminNavigationItem[] }>> = [
  { key: "overview", label: "概览", links: [
    { label: "平台总览", href: "/admin", icon: "M3 3h7v7H3z M14 3h7v7h-7z M3 14h7v7H3z M14 14h7v7h-7z" },
  ] },
  { key: "users", label: "用户与用量", links: [
    { label: "用户列表", href: "/admin/users", icon: "M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2 M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8 M22 21v-2a4 4 0 0 0-3-3.87 M16 3.13a4 4 0 0 1 0 7.75" },
    { label: "会员资格", href: "/admin/users/memberships", icon: "M3 6l5 4 4-7 4 7 5-4-2 13H5z" },
    { label: "平台额度", href: "/admin/credits", icon: "M3 5h18v14H3z M3 10h18 M7 15h4" },
  ] },
  { key: "services", label: "服务与接入", links: [
    { label: "模型与能力", href: "/admin/models", icon: "M4 3h16v7H4z M4 14h16v7H4z M7 6h.01 M7 17h.01" },
    { label: "MCP 审核", href: "/admin/connectors/mcp", icon: "M12 3l8 4v6c0 5-8 9-8 9s-8-4-8-9V7z M8 12l3 3 5-6" },
    { label: "短信服务", href: "/admin/sms", icon: "M3 3h18v14H8l-5 4z M7 8h10 M7 12h7" },
    { label: "审计记录", href: "/admin/audit", icon: "M14 2H4v20h16V8z M14 2v6h6 M8 13h8 M8 17h6" },
  ] },
  { key: "operations", label: "运行维护", links: [
    { label: "资源与备份", href: "/admin/operations/backups", icon: "M3 7l9-4 9 4-9 4z M3 7v10l9 4 9-4V7 M12 11v10" },
    { label: "失败收件箱", href: "/admin/operations/failures", icon: "M4 4h16l2 13v4H2v-4z M2 14h6l2 3h4l2-3h6" },
    { label: "模型测试额度", href: "/admin/operations/probes", icon: "M3 12h4l3-8 4 16 3-8h4" },
  ] },
  { key: "settings", label: "设置", links: [
    { label: "管理员账户", href: "/admin/account", icon: "M20 21v-2a7 7 0 0 0-14 0v2 M13 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8" },
    { label: "管理员指南", href: "/admin/guide", icon: "M3 3h7a3 3 0 0 1 3 3v16a4 4 0 0 0-4-3H3z M13 6a3 3 0 0 1 3-3h5v16h-5a3 3 0 0 0-3 3" },
  ] },
];

export const adminNavigationItems = adminNavigationGroups.flatMap(group => group.links);

export function getAdminNavigationState(pathname: string) {
  // Memberships are a sibling of user details, not a user-detail record.
  const href = (pathname === "/admin/users/memberships" || pathname.startsWith("/admin/users/memberships/")) ? "/admin/users/memberships"
    : adminNavigationItems.filter(item => item.href !== "/admin" && (pathname === item.href || pathname.startsWith(`${item.href}/`)))
      .sort((a, b) => b.href.length - a.href.length)[0]?.href ?? (pathname === "/admin" ? "/admin" : null);
  return { active: adminNavigationGroups.find(group => group.links.some(item => item.href === href))?.key ?? "overview", currentLinks: href ? [href] : [] };
}
