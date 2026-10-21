import { TABLER_ICON_PATHS } from "./tabler-icon-data";

/** Server-rendered once: static artwork needs no client-side path table or fetch. */
export function ShellIconSprite() {
  return <svg aria-hidden="true" focusable="false" width="0" height="0" style={{ position: "absolute", overflow: "hidden", pointerEvents: "none" }} data-icon-sprite="tabler">
    <defs>{Object.entries(TABLER_ICON_PATHS).map(([asset, paths]) => <g id={`aipos-icon-${asset}`} key={asset}>
      {paths.map((path, index) => <path key={index} d={path}/>)}
    </g>)}</defs>
  </svg>;
}
