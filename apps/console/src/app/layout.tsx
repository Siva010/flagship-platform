import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import './globals.css';

export const metadata: Metadata = {
  title: 'Flagship',
  description: 'Progressive delivery and experimentation platform',
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <div className="page">
          <nav className="tabs">
            <a href="/">Rule builder</a>
            <a href="/experiments">Experiment results</a>
          </nav>
        </div>
        {children}
      </body>
    </html>
  );
}
