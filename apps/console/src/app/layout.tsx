import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import { NavLink } from '@/components/NavLink';
import './globals.css';

export const metadata: Metadata = {
  title: 'Flagship Console',
  description: 'Feature flag and experimentation platform',
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-dvh">
        <header className="border-b border-line bg-surface">
          <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-6 gap-y-2 px-4 py-3 sm:px-6">
            <span className="font-semibold tracking-tight">Flagship</span>
            <nav className="flex gap-1" aria-label="Main">
              <NavLink href="/">Flags</NavLink>
              <NavLink href="/experiments">Experiments</NavLink>
              <NavLink href="/audit">Audit</NavLink>
              <NavLink href="/playground">Playground</NavLink>
            </nav>
          </div>
        </header>
        <main className="mx-auto max-w-6xl px-4 py-6 sm:px-6 sm:py-8">{children}</main>
      </body>
    </html>
  );
}
