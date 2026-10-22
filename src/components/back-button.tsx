"use client";

import Link from "next/link";
import { useTranslate } from "./appearance-provider";
import { ShellIcon } from "./shell-icon";
import { PARENT_PAGE_LINK_CLASS_NAME } from "./parent-page-link";

/** Compatibility wrapper for old call sites; navigation always uses its named parent. */
export function BackButton({ fallbackHref, label = "返回上一页" }: { fallbackHref: string; label?: string }) {
  const t = useTranslate();
  return <Link href={fallbackHref} className={PARENT_PAGE_LINK_CLASS_NAME}>
    <ShellIcon name="back" className="app-icon--control" />
    {t(label)}
  </Link>;
}
