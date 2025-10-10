#!/bin/bash

echo "🚀 Starting Inventory Web App build and deployment..."

# Step 1: Navigate to project directory
cd $(dirname "$0") || exit 1

# Step 2: Install dependencies if missing
if [ ! -d "node_modules" ]; then
  echo "📦 Installing dependencies..."
  npm install --silent || { echo "❌ npm install failed"; exit 1; }
else
  echo "📦 Dependencies already installed."
fi

# Step 3: Build app
echo "🏗️  Building Inventory app..."
npm run build || { echo "❌ Build failed"; exit 1; }

# Step 4: Deploy dist folder
TARGET_DIR="/home/genweb/public_html/datav.belocloud.com/ai2/public/inventory"

if [ ! -d "dist" ]; then
  echo "❌ No dist directory found after build."
  exit 1
fi

echo "📂 Deploying built files to $TARGET_DIR ..."
rm -rf "$TARGET_DIR"/*
cp -r dist/* "$TARGET_DIR" || { echo "❌ Deployment failed"; exit 1; }

# Step 5: Verify deployment
URL="https://datav.belocloud.com/ai2/public/inventory/"
STATUS_CODE=$(curl -s -o /dev/null -w "%{http_code}" $URL)

if [ "$STATUS_CODE" -eq 200 ]; then
  echo "✅ Inventory app live at $URL (HTTP 200)"
else
  echo "⚠️  Deployment complete, but $URL returned HTTP $STATUS_CODE"
fi

echo "🎯 Inventory Web App build and deploy process finished."

