#!/bin/bash

echo "=== Playwright Diagnostic Script ==="
echo "Time: $(date)"
echo ""

echo "1. Checking Node version:"
node --version

echo ""
echo "2. Checking npm version:"
npm --version

echo ""
echo "3. Checking if Playwright is in node_modules:"
if [ -d "node_modules/playwright" ]; then
    echo "✓ Playwright found in node_modules"
    ls -lah node_modules/playwright/package.json | head -1
    grep "version" node_modules/playwright/package.json | head -1
else
    echo "✗ Playwright NOT in node_modules"
fi

echo ""
echo "4. Checking Playwright cache directory:"
if [ -d "/root/.cache/ms-playwright" ]; then
    echo "✓ Cache directory exists"
    ls -lah /root/.cache/ms-playwright/ 2>/dev/null || echo "  Cannot list cache"
    find /root/.cache/ms-playwright -type d -name "*chromium*" 2>/dev/null | head -5
else
    echo "✗ Cache directory NOT found at /root/.cache/ms-playwright"
fi

echo ""
echo "5. Checking if 'npx playwright' works:"
which npx
npx playwright --version 2>&1 || echo "  npx playwright failed"

echo ""
echo "6. Attempting to install Playwright (testing):"
echo "Running: npx playwright install --with-deps chromium"
timeout 60 npx playwright install --with-deps chromium 2>&1 | tail -20 || echo "  Install timed out or failed"

echo ""
echo "7. Final cache check:"
if [ -d "/root/.cache/ms-playwright" ]; then
    echo "Listing contents:"
    find /root/.cache/ms-playwright -type d | head -10
else
    echo "Still no cache directory"
fi

echo ""
echo "=== Diagnostic Complete ==="
