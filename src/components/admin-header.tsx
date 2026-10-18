import Link from "next/link";
import { LogoutButton } from "@/app/logout-button";
import { BrandMark } from "@/components/brand-mark";

export function AdminHeader({ username }: { username: string }) {
  return (
    <header className="admin-global-header">
      <div className="admin-global-header-inner">
        <Link href="/admin" className="admin-brand-link" aria-label="AI Project OS 平台管理总览">
          <BrandMark size={32} priority />
          <span className="min-w-0">
            <span className="admin-brand-title">AI PROJECT OS</span>
            <span className="admin-brand-subtitle">平台运营管理</span>
          </span>
        </Link>
        <div className="admin-header-actions">
          <Link href="/admin/guide" className="admin-header-utility">管理员指南</Link>
          <Link href="/admin/account" aria-label={`管理员账户：${username}`} className="admin-account-link">{username}</Link>
          <LogoutButton className="admin-logout-button" />
        </div>
      </div>
    </header>
  );
}
