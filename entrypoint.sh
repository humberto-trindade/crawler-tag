#!/bin/bash
set -eux

echo "========== Entrypoint: Starting ==========" >&2

# Print environment
echo "Node: $(node --version)" >&2
echo "NPM: $(npm --version)" >&2
echo "PWD: $(pwd)" >&2
echo "USER: $(whoami)" >&2

# Get Playwright version from package.json
PW_VERSION=$(node -e "console.log(require('./package.json').dependencies.playwright)")
echo "Playwright version from package.json: $PW_VERSION" >&2

# Check if playwright binaries exist
CHROME_PATH="/root/.cache/ms-playwright/chromium-*/chrome-linux/chrome"
CHROME_ALT="/root/.cache/ms-playwright/chromium_headless_shell-*/chrome-headless-shell-linux64/chrome-headless-shell"

echo "Checking for existing Playwright installation..." >&2
if ls $CHROME_PATH 2>/dev/null || ls $CHROME_ALT 2>/dev/null; then
  echo "Playwright found!" >&2
  ls -la /root/.cache/ms-playwright/*/
else
  echo "Playwright NOT found. Installing..." >&2
  
  # Make sure npm modules exist
  if [ ! -d "node_modules/playwright" ]; then
    echo "Playwright package not in node_modules, installing dependencies..." >&2
    npm ci --omit=dev
  fi
  
  # Install Playwright browsers
  echo "Running: npx playwright install chromium --with-deps" >&2
  npx playwright install chromium --with-deps
  
  # Verify installation
  echo "Verifying installation..." >&2
  ls -la /root/.cache/ms-playwright/ || echo "Cache still missing"
  find /root/.cache/ms-playwright -name "chrome*" -o -name "chromium*" 2>/dev/null || echo "No chromium found"
fi

echo "========== Entrypoint: Starting application ==========" >&2
exec node dist/src/server.js
