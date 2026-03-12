"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Truck, ClipboardList, Radio, BarChart3, Package, Settings } from "lucide-react";
import { cn } from "@/lib/utils";
import { DatePicker } from "@/components/shared/date-picker";
import { useDate } from "@/context/date-context";

const tabs = [
  { href: "/plan", label: "計画", icon: ClipboardList },
  { href: "/monitor", label: "現場", icon: Radio },
  { href: "/review", label: "振り返り", icon: BarChart3 },
  { href: "/loading", label: "積み荷", icon: Package },
  { href: "/admin", label: "管理", icon: Settings },
];

export function TabNavigation() {
  const pathname = usePathname();
  const { date, setDate } = useDate();

  return (
    <header className="flex h-12 items-center border-b bg-card px-4">
      <Link href="/" className="mr-6 flex items-center gap-2 text-sm font-bold">
        <Truck className="h-5 w-5 text-chart-1" />
        <span>豊洲配送所</span>
      </Link>
      <nav className="flex gap-1">
        {tabs.map((tab) => {
          const active = pathname.startsWith(tab.href);
          return (
            <Link
              key={tab.href}
              href={tab.href}
              className={cn(
                "flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm transition-colors",
                active
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:bg-accent hover:text-foreground"
              )}
            >
              <tab.icon className="h-4 w-4" />
              {tab.label}
            </Link>
          );
        })}
      </nav>
      <div className="ml-auto">
        <DatePicker value={date} onChange={setDate} />
      </div>
    </header>
  );
}
