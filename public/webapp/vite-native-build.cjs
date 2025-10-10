// vite-native-build.cjs
// --------------------------------------
// Forces Vite to use native esbuild binary instead of WebAssembly version.
// This resolves 'crypto.getRandomValues is not a function' errors
// in restricted Node environments (like cPanel, CloudLinux, or shared hosting).

const { spawnSync } = require('child_process');
const path = require('path');

try {
  const esbuildBin = path.resolve(__dirname, 'node_modules/esbuild/bin/esbuild');
  process.env.ESBUILD_BINARY_PATH = esbuildBin;
  console.log(`⚙️  Forcing native esbuild binary: ${esbuildBin}`);

  // Run vite build using native esbuild
  const vitePath = path.resolve(__dirname, 'node_modules/vite/bin/vite.js');
  const result = spawnSync('node', [vitePath, 'build'], {
    stdio: 'inherit',
    env: process.env,
  });

  if (result.error) {
    console.error('❌ Vite build failed:', result.error);
    process.exit(1);
  }

  console.log('✅ Native esbuild build completed successfully.');
} catch (err) {
  console.error('❌ Failed to run native esbuild build:', err);
  process.exit(1);
}


