import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
// Served from this site, like everything else the page loads: no font request leaves for a third party.
// A serif for the headings, as a chart titles its sheets, and a sans for the reading.
import '@fontsource/source-sans-3/400.css';
import '@fontsource/source-sans-3/600.css';
import '@fontsource/source-sans-3/700.css';
import '@fontsource/source-serif-4/600.css';
import '@fontsource/source-serif-4/700.css';
import '@fontsource/source-serif-4/400-italic.css';
import './styles.css';

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
