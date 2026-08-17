import { login } from '@/lib/auth';
import { redirect } from 'next/navigation';

async function loginAction(formData: FormData) {
  'use server';
  const password = String(formData.get('password') ?? '');
  const next = String(formData.get('next') ?? '/dashboard');
  const ok = await login(password);
  if (!ok) redirect('/login?error=1');
  redirect(next);
}

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ next?: string; error?: string }> }) {
  const sp = await searchParams;
  return (
    <main style={{ maxWidth: 360, margin: '80px auto' }}>
      <h1>rma-ai</h1>
      <p className="muted">Admin login</p>
      <form action={loginAction} className="card">
        <div className="field">
          <label htmlFor="password">Password</label>
          <input type="password" name="password" id="password" autoFocus required />
        </div>
        <input type="hidden" name="next" value={sp?.next ?? '/dashboard'} />
        {sp?.error === '1' && (
          <p style={{ color: 'var(--danger)', fontSize: 13, margin: '0 0 12px' }}>Wrong password.</p>
        )}
        <button type="submit" className="btn btn-primary">Sign in</button>
      </form>
    </main>
  );
}
