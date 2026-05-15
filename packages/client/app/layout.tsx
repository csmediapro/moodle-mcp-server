import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Moodle MCP — Reference Client",
  description: "Reference client for the Moodle MCP server",
};

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
