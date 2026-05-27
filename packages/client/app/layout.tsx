import type { Metadata } from "next";
import "./globals.css";
import { readServerDisplayConfig } from "@/lib/server-config";

export function generateMetadata(): Metadata {
  const { serverName } = readServerDisplayConfig();

  return {
    title: serverName,
    description: `Reference client for ${serverName}`,
  };
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className="h-full">
      <body className="h-full bg-gray-50 text-gray-900 antialiased">
        {children}
      </body>
    </html>
  );
}
