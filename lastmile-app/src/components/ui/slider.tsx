"use client";

import * as React from "react";
import { cn } from "@/lib/utils";

interface SliderProps {
  className?: string;
  min?: number;
  max?: number;
  step?: number;
  value?: number[];
  defaultValue?: number[];
  onValueChange?: (value: number[]) => void;
}

const Slider = React.forwardRef<HTMLInputElement, SliderProps>(
  ({ className, min = 0, max = 100, step = 1, value, defaultValue, onValueChange }, ref) => {
    const val = value?.[0] ?? defaultValue?.[0] ?? min;
    return (
      <input
        ref={ref}
        type="range"
        min={min}
        max={max}
        step={step}
        value={val}
        onChange={(e) => onValueChange?.([Number(e.target.value)])}
        className={cn(
          "h-1.5 w-full cursor-pointer appearance-none rounded-full bg-muted accent-primary",
          className
        )}
      />
    );
  }
);
Slider.displayName = "Slider";

export { Slider };
