import type { Metadata } from "next";
import { Noto_Sans_JP } from "next/font/google";
import { TooltipProvider } from "@/components/ui/tooltip";
import { TabNavigation } from "@/components/shared/tab-navigation";
import { DateProvider } from "@/context/date-context";
import "./globals.css";

const notoSansJP = Noto_Sans_JP({
  variable: "--font-sans",
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
});

export const metadata: Metadata = {
  title: "豊洲配送所 | ラストワンマイル管理",
  description: "配送所長向け業務管理アプリケーション",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ja" className="dark">
      <body className={`${notoSansJP.variable} font-sans antialiased`}>
        <DateProvider>
          <TooltipProvider>
            <div className="flex h-screen flex-col overflow-hidden">
              <TabNavigation />
              <main className="flex-1 overflow-hidden">{children}</main>
            </div>
          </TooltipProvider>
        </DateProvider>
      </body>
    </html>
  );
}
