"use client";

import dynamic from "next/dynamic";
import { UiText } from "./appearance-provider";

// Subpages use the admin frame without downloading the overview's charts.
export const AdminOverviewClient = dynamic(
  () => import("./admin-overview-client").then(module => module.AdminOverviewClient),
  { loading: () => <p role="status"><UiText text="正在加载…" /></p> },
);
