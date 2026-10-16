/**
 * Append a picked/captured image to a multipart form — iOS and Android.
 *
 * React Native's FormData accepts a `{ uri, name, type }` descriptor and streams
 * the file from disk itself. Browsers do not: see `upload-part.web.ts`, which
 * Metro picks instead of this file when bundling for web.
 */
export interface UploadFile {
  uri: string;
  name?: string;
  type?: string;
}

export async function appendImagePart(form: FormData, field: string, file: UploadFile): Promise<void> {
  form.append(field, {
    uri: file.uri,
    name: file.name ?? 'upload.jpg',
    type: file.type ?? 'image/jpeg',
  } as unknown as Blob);
}
