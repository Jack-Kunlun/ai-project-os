import Image from "next/image";

/**
 * The shared product mark. The source image already contains the complete
 * artwork, so keep it contained instead of scaling/cropping it into the
 * header tile.
 */
export function BrandMark({
  size = 44,
  priority = false,
  className = "",
}: {
  size?: number;
  priority?: boolean;
  className?: string;
}) {
  return (
    <span
      className={`relative inline-flex shrink-0 items-center justify-center overflow-hidden rounded-xl border border-white/10 bg-slate-950 shadow-lg shadow-emerald-500/10 ${className}`}
      style={{ width: size, height: size }}
    >
      <Image
        src="/brand/ai-project-os-admin-crisp.png"
        alt=""
        width={size}
        height={size}
        priority={priority}
        sizes={`${size}px`}
        className="h-full w-full object-contain p-1"
      />
    </span>
  );
}
