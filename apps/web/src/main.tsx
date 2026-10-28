import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
// Served from this site, like everything else the page loads: no font request leaves for a third party.
// Barlow is drawn after road and airport signage; the condensed cut sets the signs, the regular sets the reading.
import '@fontsource/barlow/400.css';
import '@fontsource/barlow/500.css';
import '@fontsource/barlow/600.css';
import '@fontsource/barlow/700.css';
import '@fontsource/barlow-condensed/600.css';
import '@fontsource/barlow-condensed/700.css';
import './styles.css';

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
