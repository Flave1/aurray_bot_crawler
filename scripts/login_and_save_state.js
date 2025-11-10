/*
 Logs into a Google account in a visible Chrome browser and saves Playwright storage state.
 Usage:
   node login_and_save_state.js [output_path]
 Defaults output_path to ./auth/google_auth_state.json
*/

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

(async () => {
  // Handle output path
  const outputArg = process.argv[2];
  const defaultPath = path.resolve(__dirname, './auth/google_auth_state.json');
  const outputPath = path.resolve(outputArg || defaultPath);

  const outDir = path.dirname(outputPath);
  if (!fs.existsSync(outDir)) {
    fs.mkdirSync(outDir, { recursive: true });
  }

  console.log('🚀 Launching Chrome for Google login...');

  const browser = await chromium.launch({
    headless: false, // must be visible for manual login
    executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    args: [
      '--disable-blink-features=AutomationControlled', // hide automation
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--start-maximized',
    ],
  });

  const context = await browser.newContext({
    viewport: null,
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
  });

  const page = await context.newPage();

  // Go to Google login page
  await page.goto('https://accounts.google.com/');
  console.log('➡️ Please complete the Google login in the opened Chrome window.');
  console.log('   Once logged in, keep it open until this script finishes.');

  // Wait up to 1 minute for manual login
  await page.waitForTimeout(60000);

  // Save authentication state (cookies, local storage, etc.)
  await context.storageState({ path: outputPath });
  console.log(`✅ Auth state successfully saved to: ${outputPath}`);

  await browser.close();
  console.log('🟢 Done! You can now use this auth state to join meetings automatically.');
})();
