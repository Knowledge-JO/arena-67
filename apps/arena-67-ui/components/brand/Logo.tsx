import type { SVGProps } from 'react';

type LogoProps = SVGProps<SVGSVGElement> & {
  showWordmark?: boolean;
};

export function Logo({ showWordmark = true, className, ...props }: LogoProps) {
  return (
    <span className={`inline-flex items-center gap-2 ${className ?? ''}`}>
      <svg
        aria-hidden="true"
        viewBox="0 0 64 64"
        fill="none"
        className="size-7 shrink-0"
        {...props}
      >
        <path
          d="M32 4.5 55.5 18v28L32 59.5 8.5 46V18L32 4.5Z"
          stroke="currentColor"
          strokeWidth="3.5"
          strokeLinejoin="round"
        />
        <path
          d="M23.5 23.5c-5.2 0-8.5 4.3-8.5 10.5v2c0 6.4 3.8 10.5 9.5 10.5s9.5-3.6 9.5-9-3.4-8.4-8.4-8.4c-3.3 0-5.8 1.4-7.4 3.8"
          stroke="currentColor"
          strokeWidth="4.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <path
          d="M35 24h14l-13 22"
          stroke="currentColor"
          strokeWidth="4.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
      {showWordmark && (
        <span className="font-display text-[0.78rem] font-bold tracking-[0.16em]">
          ARENA <span className="font-ticker tracking-normal">67</span>
        </span>
      )}
    </span>
  );
}
