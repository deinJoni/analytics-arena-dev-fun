import type { Metadata } from "next";
import { Archivo, IBM_Plex_Mono } from "next/font/google";
import "./globals.css";
import { Providers } from "@/components/providers";
import { Nav } from "@/components/nav";

const archivo = Archivo({
  variable: "--font-archivo",
  subsets: ["latin"],
});

const plexMono = IBM_Plex_Mono({
  variable: "--font-plex",
  weight: ["400", "500", "600"],
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Arena HU Ladder — bot diagnostics",
  description:
    "Diagnostic loop for dev.fun Arena heads-up poker bots: standings, leaks, hand replay with reasoning, head-to-head.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className={`${archivo.variable} ${plexMono.variable} h-full antialiased`}>
      <body className="flex min-h-full flex-col bg-bg font-sans text-ink">
        <Providers>
          <Nav />
          <main className="mx-auto w-full max-w-7xl flex-1 px-4 py-6 sm:px-6">
            {children}
          </main>
          <footer className="mx-auto w-full max-w-7xl px-4 pb-8 sm:px-6">
            <p className="eyebrow">
              read-only · mart layer · duplicate poker (mirror pairs cancel card luck)
            </p>
          </footer>
        </Providers>
      </body>
    </html>
  );
}
