import { type ClassValue, clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

// Merges conditional class lists and resolves Tailwind conflicts, the shadcn
// convention, so components can accept a className override.
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
