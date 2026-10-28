/** Send the File itself, so neither browser nor server must build a multipart copy. */
export function projectAssetUploadRequest(file: File): RequestInit {
  return {
    method: "POST",
    headers: {
      "content-type": "application/octet-stream",
      "x-asset-file-name": encodeURIComponent(file.name),
      "x-asset-file-size": String(file.size),
    },
    body: file,
  };
}
