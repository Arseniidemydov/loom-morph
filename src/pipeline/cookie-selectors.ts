// Static list of CSS selectors for common cookie / consent / privacy banners.
// Injected via `display: none !important` before each capture (PLAN.md
// § "Anti-Bot Strategy"). The list is intentionally broad — we accept some
// false positives (a legitimate `[id*="cookie"]` element is rare on a
// landing page) in exchange for clean screenshots on B2B sites.
//
// If a major site's banner ships a new selector we don't catch, add it here.
export const COOKIE_BANNER_SELECTORS: readonly string[] = [
  // OneTrust
  '#onetrust-banner-sdk',
  '#onetrust-consent-sdk',
  '.onetrust-pc-dark-filter',
  // Cookiebot
  '#CybotCookiebotDialog',
  '#CybotCookiebotDialogBodyUnderlay',
  // CookieYes
  '.cky-consent-container',
  '.cky-overlay',
  // Quantcast Choice
  '.qc-cmp2-container',
  // Osano
  '.osano-cm-window',
  '.osano-cm-dialog',
  // TrustArc
  '#truste-consent-track',
  '.truste_box_overlay',
  // Generic
  '[id*="cookie-banner"]',
  '[id*="cookie-consent"]',
  '[class*="cookie-banner"]',
  '[class*="cookie-consent"]',
  '[id*="gdpr"]',
  '[class*="gdpr"]',
  '[aria-label*="cookie" i]',
  '[role="dialog"][aria-label*="consent" i]',
];

export function injectionCss(): string {
  return COOKIE_BANNER_SELECTORS.map((sel) => `${sel} { display: none !important; visibility: hidden !important; }`).join('\n');
}
