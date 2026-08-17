import Link from 'next/link';
import { requireAuth, logout } from '@/lib/auth';
import { redirect } from 'next/navigation';

async function logoutAction() {
  'use server';
  await logout();
  redirect('/login');
}

export default async function AuthedLayout({ children }: { children: React.ReactNode }) {
  await requireAuth();
  return (
    <>
      <nav className="nav">
        <span className="nav-brand">rma-ai</span>
        <Link href="/dashboard" className="nav-link">Dashboard</Link>
        <Link href="/review" className="nav-link">Review</Link>
        <Link href="/rules" className="nav-link">Rules</Link>
        <Link href="/proposals" className="nav-link">Proposals</Link>
        <div className="nav-spacer" />
        <form action={logoutAction}>
          <button type="submit" className="btn">Logout</button>
        </form>
      </nav>
      <main>{children}</main>
    </>
  );
}
