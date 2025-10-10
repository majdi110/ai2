#!/bin/bash

# Deploy script for Belo Dashboard web app
# ----------------------------------------
# This script builds the Vite + React + Tailwind app
# and moves the optimized production files into /public/webapp/

set -e

echo "🚀 Starting deployment of Belo Dashboard..."

# Step 1: Navigate to project root
cd "$(dirname "$0")"

# Step 2: Install dependencies if needed
if [ ! -d "node_modules" ]; then
  echo "📦 Installing dependencies..."
  npm install --silent
fi

# Step 3: Build the production bundle
echo "🏗️  Building app..."
npm run build --silent

# Step 4: Move built files to serve directory
echo "📂 Deploying files to production..."
rm -rf ./index.html ./assets ./vite.svg 2>/dev/null || true
cp -r dist/* .

# Step 5: Clean up build folder
rm -rf dist

echo "✅ Deployment complete!"
echo "🌐 You can now visit your live app at https://datav.belocloud.com/ai2/public/webapp/"

