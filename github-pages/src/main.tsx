import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './styles/index.css';

// StrictMode is deliberate — it is the free regression test for the Phase 4
// CSS3DObject teardown path (double-mount/unmount in dev catches anything
// that doesn't clean up after itself).
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
