#!/bin/bash

# -------------------------------------------------
# Auto-deployment script for Belo Dashboard web app
# -------------------------------------------------
# Watches for file changes and automatically rebuilds
# and deploys the Vite app to /public/webapp

set -e

cd "$(dirname "$0")"

echo "🚀 Starting auto-deploy watcher for Belo Dashboard..."

# Check dependencies
if ! command -v inotifywait &> /dev/null; then
  echo "❌ 'inotifywait' is required. Install via: sudo apt install inotify-tools"
  exit 1
fi

# Function to deploy app
deploy() {
  echo "\n🛠 Change detected — rebuilding and deploying..."
  ./deploy.sh
  echo "✅ Deployment complete at $(date '+%Y-%m-%d %H:%M:%S')"
}

# Initial deploy on start
deploy

# Watch for changes in source directories
inotifywait -m -r -e modify,create,delete,move ./src ./index.html ./tailwind.config.js ./vite.config.ts \
  | while read -r directory events filename; do
    echo "📂 Detected change in $filename ($events)"
    deploy
  done

echo "👀 Watching for file changes..."

