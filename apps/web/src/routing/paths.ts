import { directoryOrRootPathSchema, resourceNameSchema } from '@app/shared';

export function folderUrl(input: string): string {
  const path = directoryOrRootPathSchema.parse(input);
  if (!path) return '/files/';
  return '/files/' + path.slice(0, -1).split('/').map(encodeURIComponent).join('/') + '/';
}

export function folderPathFromUrl(pathname: string): string {
  if (!pathname.startsWith('/files/') || !pathname.endsWith('/')) throw new Error('Invalid folder URL');
  const encoded = pathname.slice('/files/'.length, -1);
  if (!encoded) return '';
  const segments = encoded.split('/').map(segment => resourceNameSchema.parse(decodeURIComponent(segment)));
  return directoryOrRootPathSchema.parse(segments.join('/') + '/');
}
