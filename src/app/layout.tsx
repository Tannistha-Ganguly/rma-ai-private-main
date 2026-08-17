import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'rma-ai',
  description: 'releaseMyAd editorial auto-checker',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
