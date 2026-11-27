import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

/**
 * Conditional class names, with Tailwind conflicts resolved last-wins.
 * Never build class strings by concatenation — `cn` is the only way.
 */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
