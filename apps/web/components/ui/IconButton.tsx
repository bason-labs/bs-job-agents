import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";
import { cn } from "@/lib/cn";

export interface IconButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "aria-label"> {
  /** Required: icon-only buttons need an accessible name. */
  label: string;
  icon: ReactNode;
  variant?: "ghost" | "secondary" | "primary";
  size?: "sm" | "md";
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { label, icon, variant = "ghost", size = "md", className, type = "button", title, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      aria-label={label}
      title={title ?? label}
      className={cn(
        "inline-grid shrink-0 place-items-center rounded-xl transition disabled:opacity-50",
        size === "sm" ? "size-7 [&_svg]:size-3.5" : "size-9 [&_svg]:size-4",
        variant === "ghost" && "text-muted hover:bg-surface-2 hover:text-fg",
        variant === "secondary" && "border border-border bg-surface/70 text-fg hover:border-accent",
        variant === "primary" && "bg-gradient-brand text-white shadow-glow",
        className,
      )}
      {...rest}
    >
      {icon}
    </button>
  );
});
