#!/bin/bash
set -e

echo "=== Installing Playwright Browsers ==="
cd /app

# Verify node_modules/playwright exists
if [ ! -d "node_modules/playwright" ]; then
  echo "ERROR: node_modules/playwright not found"
  exit 1
fi

echo "Playwright version: $(node -e "console.log(require('./package.json').dependencies.playwright)")"
echo ""

# Install browsers
echo "Running: npx playwright install chromium --with-deps"
npx playwright install chromium --with-deps 2>&1

# Verify installation - check for any chromium browser
echo ""
echo "Verifying installation..."

found=false

# Check for chromium-linux (older format)
if [ -f "/root/.cache/ms-playwright/chromium-linux/chrome" ]; then
  echo "✓ Found chromium-linux/chrome"
  ls -lh /root/.cache/ms-playwright/chromium-linux/chrome
  found=true
fi

# Check for chromium (standard format)
if find /root/.cache/ms-playwright/chromium-* -name "chrome" 2>/dev/null | grep -q .; then
  echo "✓ Found chromium browser executable"
  find /root/.cache/ms-playwright/chromium-* -name "chrome" -exec ls -lh {} \;
  found=true
fi

# Check for chromium_headless_shell (v1228+)
if find /root/.cache/ms-playwright/chromium_headless_shell-* -name "chrome-headless-shell" 2>/dev/null | grep -q .; then
  echo "✓ Found chrome-headless-shell executable"
  find /root/.cache/ms-playwright/chromium_headless_shell-* -name "chrome-headless-shell" -exec ls -lh {} \;
  found=true
fi

if [ "$found" = false ]; then
  echo "ERROR: No Playwright browser found after install"
  echo ""
  echo "Cache contents:"
  ls -laR /root/.cache/ms-playwright/ 2>/dev/null || echo "Cache directory not found"
  exit 1
fi

echo ""
echo "✓ Playwright installation complete"
