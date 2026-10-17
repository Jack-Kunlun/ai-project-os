type ImportAsset = { id: string; status: string };

/** Wait only for local parsing. This never dispatches a model or retries an upload. */
export async function awaitImportedAsset<T extends ImportAsset>(projectId: string, asset: T, onWaiting?: () => void): Promise<{ asset: T; pending: boolean; error?: string }> {
  let current = asset;
  const pending = () => current.status === "uploaded" || current.status === "parsing";
  for (let attempt = 0; pending() && attempt < 21; attempt += 1) {
    onWaiting?.();
    if (attempt > 0) await new Promise((resolve) => window.setTimeout(resolve, 1_500));
    try {
      const response = await fetch(`/api/projects/${projectId}/assets/${asset.id}`, { cache: "no-store" });
      const payload = await response.json() as { asset?: T; error?: { message?: string } };
      if (!response.ok || payload.asset?.id !== asset.id) return { asset: current, pending: true, error: payload.error?.message ?? "文件已保存，解析状态暂时无法读取" };
      current = payload.asset;
    } catch {
      return { asset: current, pending: true, error: "文件已保存，解析状态暂时无法读取" };
    }
  }
  return { asset: current, pending: pending() };
}
