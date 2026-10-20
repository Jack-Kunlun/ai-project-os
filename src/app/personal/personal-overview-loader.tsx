"use client";

import dynamic from "next/dynamic";
import { UiText } from "@/components/appearance-provider";

// Keep the account overview out of its sibling routes' initial client graph.
export const PersonalOverviewClient = dynamic(
  () => import("./personal-overview-client").then(module => module.PersonalOverviewClient),
  { loading: () => <p role="status"><UiText text="正在加载…" /></p> },
);
