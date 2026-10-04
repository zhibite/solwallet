import './globals.css';
import { Outfit } from 'next/font/google';
import { ThemeProvider } from '@/context/ThemeContext';
import { SidebarProvider } from '@/context/SidebarContext';
import { NoFlash } from '@/components/NoFlash';
import { ConfirmProvider } from '@/components/ui/confirm-dialog';

const outfit = Outfit({
  subsets: ["latin"],
});

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <NoFlash />
      </head>
      <body className={`${outfit.className} dark:bg-zinc-900`}>
        <ThemeProvider>
          <SidebarProvider>
            <ConfirmProvider>{children}</ConfirmProvider>
          </SidebarProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
