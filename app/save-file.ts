/** Saves a blob through a temporary link, as the browser's download. */
export function saveFile(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  // Attached first, since some browsers ignore a click on a detached link
  document.body.append(link);
  link.click();
  link.remove();
  // Some browsers read the blob after the click returns, so free it later
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
