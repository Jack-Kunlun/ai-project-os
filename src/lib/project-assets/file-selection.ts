export const SUPPORTED_PROJECT_ASSET_EXTENSIONS = [
  ".txt",
  ".md",
  ".markdown",
  ".csv",
  ".json",
  ".pdf",
  ".docx",
  ".pptx",
  ".xlsx",
  ".png",
  ".jpg",
  ".jpeg",
  ".webp",
] as const;

export type ProjectAssetSelectionResult<T> = Readonly<{
  accepted: T[];
  unsupported: T[];
  excess: T[];
}>;

/**
 * Filter by file name only. Browser and Office suite MIME types vary (notably
 * for files saved by WPS), while the upload endpoint validates actual content.
 */
export function selectSupportedProjectAssetFiles<T extends Readonly<{ name: string }>>(
  files: readonly T[],
  maxFiles: number,
): ProjectAssetSelectionResult<T> {
  const supported: T[] = [];
  const unsupported: T[] = [];
  for (const file of files) {
    const name = file.name.toLowerCase();
    if (SUPPORTED_PROJECT_ASSET_EXTENSIONS.some((extension) => name.endsWith(extension))) supported.push(file);
    else unsupported.push(file);
  }
  return {
    accepted: supported.slice(0, maxFiles),
    unsupported,
    excess: supported.slice(maxFiles),
  };
}
