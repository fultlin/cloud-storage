import { createApiClient } from './client.js';
import { createSessionExpiryHandler, queryClient } from './query-client.js';

export const api = createApiClient({ onUnauthorized: createSessionExpiryHandler(
  queryClient,
  () => window.location.pathname + window.location.search + window.location.hash,
  url => window.location.replace(url),
) });
