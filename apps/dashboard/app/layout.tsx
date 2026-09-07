import type { Metadata } from 'next';
import './globals.css';
import { QueryProvider } from '@/components/query-provider';

export const metadata: Metadata = {
  title: 'ForgeCloud',
  description: 'A miniature, locally-hosted deployment platform',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen antialiased">
        <QueryProvider>{children}</QueryProvider>
      </body>
    </html>
  );
}
