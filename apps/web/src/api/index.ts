import { createApiClient } from './client.js';
import { createSessionExpiryHandler, queryClient } from './query-client.js';

export const handleUnauthorized = createSessionExpiryHandler(
  queryClient,
  () => window.location.pathname + window.location.search + window.location.hash,
  url => window.location.replace(url),
);
export const api = createApiClient({ onUnauthorized: handleUnauthorized });
