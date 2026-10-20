"use client";

import type { CSSProperties } from "react";
import { useAppearance } from "@/components/appearance-provider";
import type { TokenUsageSummary } from "@/lib/token-usage";
import styles from "./token-usage.module.css";

const tokenStyle: CSSProperties = {
  color: "var(--app-text)",
  background: "var(--app-surface)",
  borderColor: "var(--app-border)",
};

export function TokenUsageView({
  usage,
  compact = false,
}: Readonly<{
  usage: TokenUsageSummary | null | undefined;
  compact?: boolean;
}>): React.JSX.Element {
  const { language, t } = useAppearance();
  const formatter = new Intl.NumberFormat(language === "en" ? "en-US" : "zh-CN");
  const normalized = usage ?? {
    status: "notAvailable" as const,
    requestCount: 0,
    knownRequestCount: 0,
    unknownRequestCount: 0,
    inputTokens: null,
    outputTokens: null,
    totalTokens: null,
  };
  const statusLabel = normalized.status === "partial"
    ? t("部分用量")
    : normalized.status === "unknown"
      ? t("用量未知")
      : normalized.status === "notAvailable"
        ? t("暂无模型调用记录")
        : null;
  const values = [
    [t("输入"), normalized.inputTokens],
    [t("输出"), normalized.outputTokens],
    [t("合计"), normalized.totalTokens],
  ] as const;

  return (
    <section
      aria-label={t("Token 消耗")}
      data-token-usage={normalized.status}
      className={compact ? `${styles.root} ${styles.compact}` : styles.root}
      style={tokenStyle}
    >
        <div className={styles.heading}>
        <h3>{t("Token 消耗")}</h3>
        {statusLabel ? <span className={`${styles.status} ${normalized.status === "partial" ? styles.partial : normalized.status === "unknown" ? styles.unknown : ""}`}>{statusLabel}</span> : null}
      </div>
      {normalized.status === "notAvailable" ? (
        <p className={styles.empty}>{t("暂无模型调用记录")}</p>
      ) : normalized.status === "unknown" ? (
        <p className={styles.empty}>{t("用量未知")}</p>
      ) : (
        <>
          <dl className={styles.values}>
            {values.map(([label, value], index) => (
              <div key={label} className={index === values.length - 1 ? styles.total : undefined}>
                <dt>{label}</dt>
                <dd>{value === null ? "—" : formatter.format(value)}</dd>
              </div>
            ))}
          </dl>
          <p className={styles.meta}>
            {normalized.status === "partial" ? `${t("已知部分")} · ` : ""}
            {t("模型调用")} {formatter.format(normalized.requestCount)}
            {normalized.status === "partial"
              ? ` · ${formatter.format(normalized.knownRequestCount)}/${formatter.format(normalized.requestCount)}`
              : ""}
          </p>
        </>
      )}
    </section>
  );
}
