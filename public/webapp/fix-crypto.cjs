// Fix for missing crypto.getRandomValues in cPanel or restricted Node environments
// Ensures that Vite and its dependencies can access Web Crypto API features

try {
  if (typeof globalThis.crypto === 'undefined' || typeof globalThis.crypto.getRandomValues !== 'function') {
    console.log('⚙️  Applying crypto polyfill...');
    globalThis.crypto = require('crypto').webcrypto;
  }
} catch (err) {
  console.error('❌ Failed to apply crypto polyfill:', err);
}

