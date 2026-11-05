import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router'
import './index.css'
import App from './App.js'

if (import.meta.env.DEV && import.meta.env.VITE_MOCK_API === 'true') {
  const { worker } = await import('./mocks/browser.js');
  await worker.start({
    onUnhandledFrame({ frame, defaults }) {
      const data = frame.data;
      if (data && typeof data === 'object' && 'request' in data && data.request instanceof Request &&
        new URL(data.request.url).pathname.startsWith('/api/')) defaults.error();
    },
  });
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter><App /></BrowserRouter>
  </StrictMode>,
)

