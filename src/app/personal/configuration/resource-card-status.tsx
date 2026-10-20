"use client";

import { UiText, useAppearance } from "@/components/appearance-provider";
import styles from "../../support-pages.module.css";

export function ResourceCardStatus({ total, verified, latest, verificationLabel }: Readonly<{
  total: number;
  verified: number;
  latest: string | null;
  verificationLabel: string;
}>): React.JSX.Element {
  const { language } = useAppearance();
  const latestLabel = latest === null
    ? <UiText text="暂无记录" />
    : new Intl.DateTimeFormat(language === "en" ? "en-US" : "zh-CN", {
        timeZone: "Asia/Shanghai", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
      }).format(new Date(latest));

  return <div className={styles.resourceCardStatus}>
    <p className={styles.resourceCardMetric}>
      <strong>{total}</strong>{" "}
      {language === "en"
        ? <UiText text={total === 1 ? "connection" : "connections"} />
        : <UiText text="个连接" />}
    </p>
    <p className="text-xs font-medium text-slate-600">
      {total === 0 ? <UiText text="尚未添加连接" /> : <><UiText text="已验证" /> {verified}</>}
    </p>
    <p className="mt-1 text-xs text-slate-500"><UiText text={verificationLabel} /> · {latestLabel}</p>
  </div>;
}
