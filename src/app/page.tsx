import { redirect } from 'next/navigation';
import { isAuthed } from '@/lib/auth';

export default async function Home() {
  const ok = await isAuthed();
  redirect(ok ? '/dashboard' : '/login');
}
