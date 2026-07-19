import type { LucideProps } from "lucide-react";

/** Shared default size for toolbar / chrome icons. */
export const iconProps = {
  size: 16,
  strokeWidth: 1.75,
  "aria-hidden": true as const,
};

export type IconProps = LucideProps;
