export type InquiryBox = { left: number; right: number; top: number; width: number; height: number };
export type InquiryViewport = { width: number; height: number };
export type InquiryPlacement =
  | { mode: "beside"; left: number; top: number; width: number; height: number }
  | { mode: "floating" | "compact"; left: number; top: number; width: number; height: number };

const EDGE = 8;
const GAP = 16;
const MIN_SIDE_SPACE = 320;

/** Place the assistant beside an operation when there is usable room. */
export function inquiryPlacement(box: InquiryBox, viewport: InquiryViewport, wide = false): InquiryPlacement {
  const requestedWidth = wide ? 650 : 450;
  const height = Math.min(740, Math.max(0, viewport.height - 16));
  const leftSpace = Math.max(0, box.left - 24);
  const rightSpace = Math.max(0, viewport.width - box.right - 24);
  const sideSpace = Math.max(leftSpace, rightSpace);

  if (viewport.width > 700 && sideSpace >= MIN_SIDE_SPACE) {
    const width = Math.min(requestedWidth, sideSpace);
    const left = leftSpace >= rightSpace ? box.left - GAP - width : box.right + GAP;
    const top = Math.min(Math.max(38, box.top), Math.max(EDGE, viewport.height - height - EDGE));
    return { mode: "beside", left, top, width, height };
  }

  if (viewport.width <= 700) {
    const width = Math.max(0, viewport.width - EDGE * 2);
    const height = Math.min(520, Math.max(0, viewport.height * 0.55));
    return { mode: "compact", left: EDGE, top: EDGE, width, height };
  }

  const width = Math.max(0, Math.min(requestedWidth, viewport.width - EDGE * 2));
  const floatingHeight = Math.min(740, Math.max(0, viewport.height - EDGE * 2));
  const top = Math.min(Math.max(38, box.top), Math.max(EDGE, viewport.height - floatingHeight - EDGE));
  return { mode: "floating", left: viewport.width - width - EDGE, top, width, height: floatingHeight };
}

export function clampInquiryPosition(
  point: { left: number; top: number },
  panel: { width: number; height: number },
  viewport: InquiryViewport,
  edge = EDGE,
) {
  return {
    left: Math.max(edge, Math.min(viewport.width - panel.width - edge, point.left)),
    top: Math.max(edge, Math.min(viewport.height - panel.height - edge, point.top)),
  };
}
