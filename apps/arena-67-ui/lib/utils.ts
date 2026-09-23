import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export const shortAddress = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
