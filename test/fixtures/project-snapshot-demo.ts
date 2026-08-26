export const PROJECT_SNAPSHOT_DEMO_PROJECT_NAME = "AI Project OS · Project Snapshot 演示样本";
export const PROJECT_SNAPSHOT_DEMO_MARKER = "AI_PROJECT_OS_PROJECT_SNAPSHOT_DEMO_MARKER_V1";
export const PROJECT_SNAPSHOT_DEMO_DESCRIPTION =
  `Project Snapshot 可重复演示样本；仅包含公开的 AI Project OS 原型内容。标记：${PROJECT_SNAPSHOT_DEMO_MARKER}`;
export const PROJECT_SNAPSHOT_DEMO_SLUG_PREFIX = "ai-project-os-project-snapshot-demo";

export const projectSnapshotProgressCorrection = {
  beforeTitle: "Project Snapshot 样本进度（修正前）",
  afterTitle: "Project Snapshot 样本进度（修正后）",
  before: "进展修正前：Project Snapshot 样本仍只有三类已确认条目。",
  after: "进展修正后：Project Snapshot 已补齐四类已确认条目，并保留原文摘录。",
  beforeSourceExcerpt: "进展修正前：Project Snapshot 样本仍只有三类已确认条目。",
  afterSourceExcerpt: "进展修正后：Project Snapshot 已补齐四类已确认条目，并保留原文摘录。",
} as const;

export type ProjectSnapshotFixtureSource = {
  key: string;
  kind: "manual";
  contentText: string;
  externalRef: null;
  capturedAt: string;
};

export type ProjectSnapshotFixtureItem = {
  key: string;
  type: "decision" | "progress" | "issue" | "risk";
  title: string;
  content: string;
  sourceKey: string;
  sourceExcerpt: string;
  occurredAt: string;
  reviewStatus: "confirmed";
};

export const projectSnapshotFixtureSources: readonly ProjectSnapshotFixtureSource[] = [
  {
    key: "project-snapshot-plan",
    kind: "manual",
    contentText: [
      "AI Project OS Project Snapshot 演示记录",
      "决策：V0 使用 Project Snapshot 作为可追溯的项目状态读取点。",
      projectSnapshotProgressCorrection.beforeSourceExcerpt,
      projectSnapshotProgressCorrection.afterSourceExcerpt,
      "演示规则：Focus 按 Issues 后 Risks 的确定性顺序展示，不表示优先级。",
    ].join("\n"),
    externalRef: null,
    capturedAt: "2026-08-26T08:00:00.000Z",
  },
  {
    key: "project-snapshot-review",
    kind: "manual",
    contentText: [
      "AI Project OS Project Snapshot 人工核对记录",
      "问题：修正已确认条目后，旧 Snapshot 可能不再代表当前确认集合。",
      "风险：如果没有核对原文摘录，项目状态可能被错误地当作已验证事实。",
      "验收：用户应能从 Item 回看 Source 原文，并判断当前项目状态。",
    ].join("\n"),
    externalRef: null,
    capturedAt: "2026-08-26T09:00:00.000Z",
  },
];

export const projectSnapshotFixtureItems: readonly ProjectSnapshotFixtureItem[] = [
  {
    key: "decision-snapshot",
    type: "decision",
    title: "V0 使用可追溯 Project Snapshot",
    content: "V0 使用 Project Snapshot 作为项目状态读取点，每条确认内容保留 Source 摘录。",
    sourceKey: "project-snapshot-plan",
    sourceExcerpt: "决策：V0 使用 Project Snapshot 作为可追溯的项目状态读取点。",
    occurredAt: "2026-08-26T08:10:00.000Z",
    reviewStatus: "confirmed",
  },
  {
    key: "progress-correction",
    type: "progress",
    title: projectSnapshotProgressCorrection.beforeTitle,
    content: projectSnapshotProgressCorrection.before,
    sourceKey: "project-snapshot-plan",
    sourceExcerpt: projectSnapshotProgressCorrection.beforeSourceExcerpt,
    occurredAt: "2026-08-26T08:30:00.000Z",
    reviewStatus: "confirmed",
  },
  {
    key: "issue-stale",
    type: "issue",
    title: "修正确认内容后旧 Snapshot 会变旧",
    content: "修正已确认条目后，旧 Snapshot 可能不再代表当前确认集合，需要重新生成。",
    sourceKey: "project-snapshot-review",
    sourceExcerpt: "问题：修正已确认条目后，旧 Snapshot 可能不再代表当前确认集合。",
    occurredAt: "2026-08-26T09:10:00.000Z",
    reviewStatus: "confirmed",
  },
  {
    key: "risk-provenance",
    type: "risk",
    title: "未核对摘录会削弱状态可信度",
    content: "如果没有核对原文摘录，项目状态可能被错误地当作已验证事实。",
    sourceKey: "project-snapshot-review",
    sourceExcerpt: "风险：如果没有核对原文摘录，项目状态可能被错误地当作已验证事实。",
    occurredAt: "2026-08-26T09:20:00.000Z",
    reviewStatus: "confirmed",
  },
];

export const projectSnapshotFixture = {
  project: {
    name: PROJECT_SNAPSHOT_DEMO_PROJECT_NAME,
    description: PROJECT_SNAPSHOT_DEMO_DESCRIPTION,
  },
  sources: projectSnapshotFixtureSources,
  items: projectSnapshotFixtureItems,
  progressCorrection: projectSnapshotProgressCorrection,
} as const;
