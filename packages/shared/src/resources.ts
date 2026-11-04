import { z } from 'zod';
import { directoryOrRootPathSchema, directoryPathSchema, resourceNameSchema, resourcePathSchema } from './paths.js';

export const createDirectoryQuerySchema = z.object({ path: directoryPathSchema });
export type CreateDirectoryQuery = z.infer<typeof createDirectoryQuerySchema>;

export const directoryResourceSchema = z.object({
  path: directoryOrRootPathSchema,
  name: resourceNameSchema,
  type: z.literal('DIRECTORY'),
});
export type DirectoryResource = z.infer<typeof directoryResourceSchema>;

export const resourceQuerySchema = z.object({ path: resourcePathSchema });
export type ResourceQuery = z.infer<typeof resourceQuerySchema>;
export const fileResourceSchema = z.object({
  path: directoryOrRootPathSchema,
  name: resourceNameSchema,
  size: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  type: z.literal('FILE'),
});
export const resourceSchema = z.discriminatedUnion('type', [directoryResourceSchema, fileResourceSchema]);
export type Resource = z.infer<typeof resourceSchema>;

export const listDirectoryQuerySchema = z.object({ path: directoryOrRootPathSchema });
export type ListDirectoryQuery = z.infer<typeof listDirectoryQuerySchema>;

export const moveResourceQuerySchema = z.object({ from: resourcePathSchema, to: resourcePathSchema });
export type MoveResourceQuery = z.infer<typeof moveResourceQuerySchema>;
