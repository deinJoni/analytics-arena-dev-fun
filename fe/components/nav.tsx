"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const LINKS = [
  { href: "/", label: "Overview" },
  { href: "/hands", label: "Hands" },
  { href: "/matchups", label: "Head-to-head" },
];

export function Nav() {
  const pathname = usePathname();
  const isActive = (href: string) =>
    href === "/" ? pathname === "/" : pathname.startsWith(href);

  return (
    <header className="sticky top-0 z-40 border-b border-line bg-bg/90 backdrop-blur">
      <div className="mx-auto flex h-12 max-w-7xl items-center gap-6 px-4 sm:px-6">
        <Link href="/" className="flex items-baseline gap-2">
          <span className="font-mono text-sm font-semibold tracking-widest text-ink">
            ARENA
          </span>
          <span className="eyebrow text-accent">hu ladder · s1</span>
        </Link>
        <nav className="flex items-center gap-1 text-sm">
          {LINKS.map((l) => (
            <Link
              key={l.href}
              href={l.href}
              className={`rounded px-3 py-1.5 transition-colors ${
                isActive(l.href)
                  ? "bg-surface2 text-ink"
                  : "text-ink2 hover:bg-surface hover:text-ink"
              }`}
            >
              {l.label}
            </Link>
          ))}
        </nav>
      </div>
    </header>
  );
}
