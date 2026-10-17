export const PROJECT_KNOWLEDGE_TERMS = Object.freeze([
  Object.freeze({ key: "source", label: "原始资料", detail: "用户录入或连接读取的原始内容" }),
  Object.freeze({ key: "candidate", label: "AI 候选", detail: "需要人工核对的冲突、改写或不确定内容" }),
  Object.freeze({ key: "fact", label: "已确认事实", detail: "通过原文证据自动准入或人工确认，已进入项目事实层的内容" }),
  Object.freeze({ key: "memory", label: "AI 可引用记忆", detail: "已发布到兼容索引、可被 AI 引用的内容" }),
] as const);

export const PROJECT_KNOWLEDGE_FLOW_LABEL = PROJECT_KNOWLEDGE_TERMS.map((term) => term.label).join(" → ");
