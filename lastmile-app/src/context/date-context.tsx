"use client";

import { createContext, useContext, useState, type ReactNode } from "react";

interface DateContextValue {
  date: string;
  setDate: (date: string) => void;
}

const DateContext = createContext<DateContextValue | null>(null);

export function DateProvider({ children }: { children: ReactNode }) {
  const [date, setDate] = useState(new Date().toISOString().split("T")[0]);
  return (
    <DateContext.Provider value={{ date, setDate }}>
      {children}
    </DateContext.Provider>
  );
}

export function useDate() {
  const ctx = useContext(DateContext);
  if (!ctx) throw new Error("useDate must be used within DateProvider");
  return ctx;
}
