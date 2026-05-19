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

// Active "accept" selectors. We try these BEFORE the CSS hide kicks in so
// the user's consent is recorded — important for sites that block content
// (videos, embeds, scripts) until you accept. Ordered with the most
// specific / common library selectors first; generics last.
export const COOKIE_ACCEPT_SELECTORS: readonly string[] = [
  // OneTrust
  '#onetrust-accept-btn-handler',
  // Cookiebot — multiple flavors of the same button across versions
  '#CybotCookiebotDialogBodyButtonAccept',
  '#CybotCookiebotDialogBodyLevelButtonAccept',
  '#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll',
  '#CybotCookiebotDialogBodyLevelButtonAcceptAll',
  // CookieYes
  '.cky-btn-accept',
  // Quantcast Choice — the "Agree" button has mode="primary"
  '.qc-cmp2-summary-buttons button[mode="primary"]',
  // Osano
  '.osano-cm-accept-all',
  '.osano-cm-accept',
  // TrustArc
  '#truste-consent-button',
  '.trustarc-agree-btn',
  // Usercentrics (used by many SaaS landing pages)
  '[data-testid="uc-accept-all-button"]',
  'button[data-cy="uc-accept-all-button"]',
  // Didomi
  '#didomi-notice-agree-button',
  // SourcePoint (TCF v2)
  '.sp_choice_type_11',
  '.message-component.message-button.no-children.focusable[title*="Accept" i]',
  // Generic attribute matches
  'button[id*="accept" i][id*="cookie" i]',
  'button[class*="accept" i][class*="cookie" i]',
];

// Text patterns used as a last resort — many bespoke banners (especially
// on small B2B / agency sites) don't ship one of the major CMP selectors
// above, so the only signal we have is the button label. Patterns cover
// the languages we've actually hit production traffic from: en, de, fr,
// es, it, nl, pt. Order doesn't matter; matching is independent.
export const COOKIE_ACCEPT_TEXT_PATTERNS: readonly RegExp[] = [
  // English
  /^accept(\s+all(\s+cookies)?)?$/i,
  /^allow(\s+all(\s+cookies)?)?$/i,
  /^agree$/i,
  /^i\s+agree$/i,
  /^got\s+it!?$/i,
  /^ok$/i,
  /^continue$/i,
  /^understood$/i,
  /^accept\s+&\s+continue$/i,
  /^that'?s\s+ok$/i,
  // German — covers valencia.ch and most DACH-region sites
  /^akzeptieren$/i,
  /^alle\s+akzeptieren$/i,
  /^alle\s+zulassen$/i,
  /^zustimmen$/i,
  /^alle\s+zustimmen$/i,
  /^einverstanden$/i,
  /^verstanden$/i,
  // French
  /^accepter$/i,
  /^tout\s+accepter$/i,
  /^j'accepte$/i,
  /^j'autorise$/i,
  /^autoriser(\s+tout)?$/i,
  /^d'accord$/i,
  // Spanish
  /^aceptar$/i,
  /^aceptar\s+todo$/i,
  /^aceptar\s+todas$/i,
  /^de\s+acuerdo$/i,
  /^permitir(\s+todo)?$/i,
  // Italian
  /^accetta$/i,
  /^accetta\s+tutto$/i,
  /^acconsento$/i,
  /^consenti(\s+tutto)?$/i,
  // Dutch
  /^accepteren$/i,
  /^alles\s+accepteren$/i,
  /^akkoord$/i,
  // Portuguese
  /^aceitar$/i,
  /^aceitar\s+tudo$/i,
  /^aceitar\s+todos$/i,
  /^concordo$/i,
];
