import { NextResponse, type NextRequest } from 'next/server';

const PUBLIC_PATHS = ['/login', '/api/health'];

export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  if (PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(p + '/'))) {
    return NextResponse.next();
  }
  if (pathname.startsWith('/_next') || pathname.startsWith('/favicon')) {
    return NextResponse.next();
  }
  const cookie = req.cookies.get('rma_ai_session');
  const expected = process.env.ADMIN_PASSWORD;
  if (!cookie || !expected || cookie.value !== expected) {
    // Build an absolute redirect URL that works behind a reverse proxy.
    // req.nextUrl uses the socket address (localhost:PORT), not the public host.
    // Read X-Forwarded-Host / X-Forwarded-Proto set by nginx instead.
    const host = req.headers.get('x-forwarded-host') || req.headers.get('host') || req.nextUrl.host;
    const proto = req.headers.get('x-forwarded-proto') || req.nextUrl.protocol.replace(':', '');
    const loginUrl = new URL(`/login?next=${encodeURIComponent(pathname)}`, `${proto}://${host}`);
    return NextResponse.redirect(loginUrl);
  }
  return NextResponse.next();
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
