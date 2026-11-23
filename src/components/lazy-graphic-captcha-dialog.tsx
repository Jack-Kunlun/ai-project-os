"use client";

import dynamic from "next/dynamic";
import type { GraphicCaptchaDialogProps } from "./graphic-captcha-dialog";

export type { GraphicCaptchaProof } from "./graphic-captcha-dialog";

const GraphicCaptchaDialog = dynamic(() => import("./graphic-captcha-dialog").then((module) => module.GraphicCaptchaDialog));

export function LazyGraphicCaptchaDialog(props: GraphicCaptchaDialogProps) {
  return <GraphicCaptchaDialog {...props} />;
}
