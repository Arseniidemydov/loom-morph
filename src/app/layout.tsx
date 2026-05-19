import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Loom Morph',
  description: 'Batch-generate personalized outreach videos from lead websites.',
  icons: {
    icon: '/loommorph_logo.png',
    apple: '/loommorph_logo.png',
  },
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
