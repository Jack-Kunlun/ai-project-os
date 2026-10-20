"use client";

import dynamic from "next/dynamic";
import { UiText } from "@/components/appearance-provider";

// The graph has its own client; it does not need the knowledge editor bundle.
export const KnowledgeClient = dynamic(
  () => import("./knowledge-client").then(module => module.KnowledgeClient),
  { loading: () => <p role="status"><UiText text="正在加载…" /></p> },
);
