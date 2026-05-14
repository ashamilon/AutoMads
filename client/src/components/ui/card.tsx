import { cn } from "@/lib/utils";
import type { HTMLAttributes } from "react";

export function Card({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        "rounded-2xl border border-white/[0.07] bg-gradient-to-br from-white/[0.06] to-transparent p-6 shadow-card",
        className,
      )}
      {...props}
    />
  );
}
