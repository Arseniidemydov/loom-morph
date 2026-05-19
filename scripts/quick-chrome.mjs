import playwrightExtra from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
playwrightExtra.chromium.use(StealthPlugin());
try {
  const browser = await playwrightExtra.chromium.launch({ headless: true, channel: 'chrome' });
  console.log('Chrome channel launched OK');
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  const page = await context.newPage();
  await page.setContent('<html><body><h1>hi</h1></body></html>');
  const title = await page.evaluate('document.title');
  console.log('Page eval OK, title=', JSON.stringify(title));
  await context.close();
  await browser.close();
  console.log('Clean shutdown OK');
} catch (err) {
  console.log('Chrome launch failed:', err.message);
}
