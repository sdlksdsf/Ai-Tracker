/** Same shape as in upload-part.ts (not imported: on web that path resolves to this file). */
export interface UploadFile {
  uri: string;
  name?: string;
  type?: string;
}

/**
 * Append a picked/captured image to a multipart form — web.
 *
 * In a browser the image picker and camera hand back a `blob:` or `data:` URI.
 * Appending React Native's `{ uri, name, type }` descriptor here (as the shared
 * code used to) makes the browser send the string "[object Object]" instead of
 * a file, so every upload from the web app reached the API with no image.
 * Fetching the URI yields the real bytes as a Blob.
 */
export async function appendImagePart(form: FormData, field: string, file: UploadFile): Promise<void> {
  const response = await fetch(file.uri);
  const blob = await response.blob();
  // The API rejects a part whose content type is not image/* — never send an
  // untyped blob (some sources report an empty type).
  const typed = blob.type.startsWith('image/') ? blob : new Blob([blob], { type: file.type ?? 'image/jpeg' });
  form.append(field, typed, file.name ?? 'upload.jpg');
}
