import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';

const SESSION_COOKIE = 'rma_ai_session';

export async function isAuthed(): Promise<boolean> {
  const jar = await cookies();
  const c = jar.get(SESSION_COOKIE);
  if (!c) return false;
  const expected = process.env.ADMIN_PASSWORD;
  if (!expected) return false;
  return c.value === expected;
}

export async function requireAuth(): Promise<void> {
  if (!(await isAuthed())) redirect('/login');
}

export async function login(password: string): Promise<boolean> {
  const expected = process.env.ADMIN_PASSWORD;
  if (!expected || password !== expected) return false;
  const jar = await cookies();
  jar.set(SESSION_COOKIE, expected, {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    maxAge: 60 * 60 * 24 * 30,
    secure: process.env.NODE_ENV === 'production',
  });
  return true;
}

export async function logout(): Promise<void> {
  const jar = await cookies();
  jar.delete(SESSION_COOKIE);
}
