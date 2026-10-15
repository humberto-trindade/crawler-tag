import type { Metadata } from "next";
import "./globals.css";
import { AppNavigation } from "../components/AppNavigation";

export const metadata: Metadata = {
  title: "Crawler Tag",
  description: "Auditoria de tracking client-side",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="pt-BR">
      <body>
        <AppNavigation />
        <main className="mx-auto max-w-7xl px-4 py-6 md:px-6">{children}</main>
      </body>
    </html>
  );
}
