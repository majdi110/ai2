import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './index.css';

const root = ReactDOM.createRoot(document.getElementById('root'));
root.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);

// index.css file to reset margin/padding and set box-sizing
// (empty or minimal as App.css has main styles)

/* no additional styles here, all in App.css */
