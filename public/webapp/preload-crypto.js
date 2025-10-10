// Preload Crypto Polyfill for Restricted Node Environments (e.g. cPanel, Plesk)
// Ensures crypto.getRandomValues exists before Vite or ESBuild initialize

try {
  if (typeof globalThis.crypto === 'undefined' || typeof globalThis.crypto.getRandomValues !== 'function') {
    const nodeCrypto = require('crypto');
    if (nodeCrypto.webcrypto) {
      globalThis.crypto = nodeCrypto.webcrypto;
      console.log('⚙️  Preloaded crypto polyfill successfully.');
    } else {
      console.warn('⚠️  WebCrypto not available in this Node environment.');
    }
  }
} catch (err) {
  console.error('❌ Failed to preload crypto polyfill:', err);
}

