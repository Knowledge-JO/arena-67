import Link from 'next/link';

export function Nav() {
  return (
    <header className="sticky top-0 z-40 border-b border-line bg-paper/95 backdrop-blur-sm">
      <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-5 sm:px-8">
        <Link
          href="/"
          className="flex items-center gap-2 font-display text-sm font-bold tracking-tight text-ink"
        >
          ARENA
          <span className="grid h-5 w-8 place-items-center border border-ink font-ticker text-[10px] font-medium">
            67
          </span>
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