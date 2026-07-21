export function isImageFile(name: string) {
  return /\.(jpe?g|png)$/i.test(name);
}

export function previewDataUrl(mime: string, dataBase64: string) {
  return `data:${mime};base64,${dataBase64}`;
}
