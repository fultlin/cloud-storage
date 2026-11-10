import type { paths } from '../api/schema.js';
export type Resource = paths['/api/resource']['get']['responses'][200]['content']['application/json'];
export function resourcePath(resource: Resource): string {
  return resource.path + resource.name + (resource.type === 'DIRECTORY' ? '/' : '');
}
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} Б`;
  const units = ['КиБ', 'МиБ', 'ГиБ'];
  let value = bytes / 1024;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) { value /= 1024; index++; }
  return `${value.toLocaleString('ru-RU', { maximumFractionDigits: 1 })} ${units[index]}`;
}
