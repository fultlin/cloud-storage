import { z } from 'zod';
import { directoryOrRootPathSchema, directoryPathSchema, resourceNameSchema } from './paths.js';

export const createDirectoryQuerySchema = z.object({ path: directoryPathSchema });
export type CreateDirectoryQuery = z.infer<typeof createDirectoryQuerySchema>;

export const directoryResourceSchema = z.object({
  path: directoryOrRootPathSchema,
  name: resourceNameSchema,
  type: z.literal('DIRECTORY'),
});
export type DirectoryResource = z.infer<typeof directoryResourceSchema>;
