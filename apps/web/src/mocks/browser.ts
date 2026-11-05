import { setupWorker } from 'msw/browser';
import { createMockHandlers } from './handlers.js';

export const worker = setupWorker(...createMockHandlers());
