import { NextResponse, type NextRequest } from 'next/server';

// HTTP Basic Auth gate for the whole app (UI + API), so a public deploy URL
// (e.g. Render) isn't open to the internet. Credentials come from env:
//
//   BASIC_AUTH_USER       — username
//   BASIC_AUTH_PASSWORD   — password
//
// Auth is DISABLED unless BOTH are set, so local dev and CI stay open with no
// config. Once the browser authenticates, it caches the credentials and
// re-sends them on same-origin fetch/EventSource requests, so the SSE progress
// stream keeps working after the initial prompt.
//
// Runs in the edge runtime, so it uses Web globals only (atob, no Buffer).

const USER = process.env.BASIC_AUTH_USER;
const PASS = process.env.BASIC_AUTH_PASSWORD;

// Length-aware constant-time compare — avoids leaking match length/position
// via timing. Cheap; fine for a single shared credential.
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i += 1) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}

function unauthorized(): NextResponse {
  return new NextResponse('Authentication required.', {
    status: 401,
    headers: {
      'WWW-Authenticate': 'Basic realm="Loom Morph", charset="UTF-8"',
    },
  });
}

export function middleware(req: NextRequest): NextResponse {
  // Not configured → no gate.
  if (!USER || !PASS) return NextResponse.next();

  const header = req.headers.get('authorization');
  if (header && header.startsWith('Basic ')) {
    try {
      const decoded = atob(header.slice('Basic '.length));
      const sep = decoded.indexOf(':');
      if (sep !== -1) {
        const user = decoded.slice(0, sep);
        const pass = decoded.slice(sep + 1);
        // Evaluate both compares regardless so timing doesn't reveal which
        // half failed.
        const ok = safeEqual(user, USER) && safeEqual(pass, PASS);
        if (ok) return NextResponse.next();
      }
    } catch {
      // Malformed base64 — fall through to a 401 challenge.
    }
  }
  return unauthorized();
}

export const config = {
  // Gate everything except Next's static assets and the favicon. API routes
  // ARE covered (the video/report endpoints must be protected too).
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
