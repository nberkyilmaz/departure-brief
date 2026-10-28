import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
// Served from this site, like everything else the page loads: no font request leaves for a third party.
import '@fontsource-variable/plus-jakarta-sans';
import './styles.css';

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
