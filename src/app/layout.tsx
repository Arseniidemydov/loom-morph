import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Loom Morph',
  description: 'Batch-generate personalized outreach videos from lead websites.',
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
