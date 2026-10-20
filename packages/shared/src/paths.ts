import { z } from 'zod';

const MAX_SEGMENT_CHARACTERS = 255;
const MAX_KEY_BYTES = 1024;
const encoder = new TextEncoder();

// Путь уже должен быть декодирован HTTP-слоем ровно один раз.
// Здесь ничего не обрезаем, не декодируем и не схлопываем сегменты.
const pathSchema = z.string().superRefine((path, context) => {
  const reject = (message: string): void => {
    context.addIssue({ code: 'custom', message });
  };

  // Непарные суррогаты не являются корректным Unicode и при UTF-8-кодировании заменяются.
  if (/[\uD800-\uDFFF]/u.test(path)) {
    reject('Path must contain valid Unicode');
    return;
  }
  if (encoder.encode(path).byteLength > MAX_KEY_BYTES) {
    reject('Path exceeds the storage key limit');
    return;
  }
  if (path.startsWith('/') || path.includes('//') || path.includes('\\')) {
    reject('Path must be relative and use single forward slashes');
    return;
  }
  if (Array.from(path).some(character => {
    const code = character.charCodeAt(0);
    return code <= 0x1f || code === 0x7f;
  })) {
    reject('Path must not contain control characters');
    return;
  }

  // Корень проверяет схема конкретного контекста; один завершающий / обозначает папку.
  if (path === '') return;
  const segments = (path.endsWith('/') ? path.slice(0, -1) : path).split('/');
  for (const segment of segments) {
    if (segment === '.' || segment === '..') {
      reject('Path must not contain dot segments');
    }
    if (segment.startsWith(' ') || segment.endsWith(' ')) {
      reject('Path segments must not start or end with a space');
    }
    if (Array.from(segment).length > MAX_SEGMENT_CHARACTERS) {
      reject('Path segments must contain at most 255 characters');
    }
  }
});

export const resourcePathSchema = pathSchema.refine(path => path !== '', 'Resource path must not be empty');
export const filePathSchema = resourcePathSchema.refine(path => !path.endsWith('/'), 'File path must not end with /');
export const directoryPathSchema = resourcePathSchema.refine(path => path.endsWith('/'), 'Directory path must end with /');
export const directoryOrRootPathSchema = pathSchema.refine(
  path => path === '' || path.endsWith('/'), 'Directory path must end with /',
);
export const resourceNameSchema = resourcePathSchema.refine(
  path => !path.includes('/'), 'Resource name must contain exactly one segment',
);

const schemas = {
  resource: resourcePathSchema,
  file: filePathSchema,
  directory: directoryPathSchema,
  'directory-or-root': directoryOrRootPathSchema,
  name: resourceNameSchema,
};

export interface PathValidationOptions {
  readonly kind?: keyof typeof schemas;
  // Сервер задаёт доверенный префикс для проверки длины; в результат он не попадает.
  readonly keyPrefix?: string;
}

export function normalizeAndValidatePath(input: unknown, options: PathValidationOptions = {}): string {
  const schema = schemas[options.kind ?? 'resource'];
  const prefix = options.keyPrefix ?? '';
  return schema.refine(
    path => encoder.encode(prefix + path).byteLength <= MAX_KEY_BYTES,
    'Path exceeds the storage key limit',
  ).parse(input);
}
