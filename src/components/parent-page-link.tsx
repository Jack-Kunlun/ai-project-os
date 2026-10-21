import Link from "next/link";
import { UiText } from "./appearance-provider";
import { ShellIcon } from "./shell-icon";

export const PARENT_PAGE_LINK_CLASS_NAME = "parent-page-link";

export function ParentPageLink({ href, label, scroll }: { href: string; label: string; scroll?: boolean }) {
  return (
    <Link
      href={href}
      scroll={scroll}
      className={PARENT_PAGE_LINK_CLASS_NAME}
    >
      <ShellIcon name="back" className="app-icon--compact" />
      <UiText text={label} />
    </Link>
  );
}
