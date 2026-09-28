import Link from 'next/link';
import { Logo } from '../brand/Logo';

export function Nav() {
  return (
    <header className="sticky top-0 z-40 border-b border-line bg-paper/95 backdrop-blur-sm">
      <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-5 sm:px-8">
        <Link
          href="/"
          aria-label="Arena 67 home"
          className="text-ink transition-colors hover:text-ink-muted"
        >
          <Logo />
        </Link>

        <Link
          href="/dashboard"
          className="inline-flex items-center gap-2 rounded-xl bg-ink px-4 py-2 text-sm font-medium text-paper transition-all hover:bg-ink/85 active:scale-[0.98]"
        >
          Open Dashboard
        </Link>
      </div>
    </header>
  );
}
