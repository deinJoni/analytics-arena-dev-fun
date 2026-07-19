"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { SearchPalette } from "@/components/search-palette";

const LINKS = [
  { href: "/", label: "Overview" },
  { href: "/hands", label: "Hands" },
  { href: "/matchups", label: "Head-to-head" },
  { href: "/compare", label: "Compare" },
];

export function Nav() {
  const pathname = usePathname();
  const [searchOpen, setSearchOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const isActive = (href: string) =>
    href === "/" ? pathname === "/" : pathname.startsWith(href);

  // Close the mobile menu on navigation…
  useEffect(() => {
    setMenuOpen(false);
  }, [pathname]);

  // …and on Esc.
  useEffect(() => {
    if (!menuOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenuOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [menuOpen]);

  return (
    <header className="sticky top-0 z-40 border-b border-line bg-bg/90 backdrop-blur">
      <div className="mx-auto flex h-12 max-w-7xl items-center gap-6 px-4 sm:px-6">
        <Link href="/" className="flex shrink-0 items-baseline gap-2" onClick={() => setMenuOpen(false)}>
          <span className="font-mono text-sm font-semibold tracking-widest text-ink">
            ARENA
          </span>
          <span className="eyebrow whitespace-nowrap text-accent">hu ladder · s1</span>
        </Link>
        <nav className="hidden items-center gap-1 text-sm sm:flex">
          {LINKS.map((l) => (
            <Link
              key={l.href}
              href={l.href}
              className={`whitespace-nowrap rounded px-3 py-1.5 transition-colors ${
                isActive(l.href)
                  ? "bg-surface2 text-ink"
                  : "text-ink2 hover:bg-surface hover:text-ink"
              }`}
            >
              {l.label}
            </Link>
          ))}
        </nav>
        <button
          type="button"
          onClick={() => setSearchOpen(true)}
          aria-label="Search agents"
          className="ml-auto flex items-center gap-2 rounded border border-line bg-surface px-2.5 py-1.5 text-ink3 transition-colors hover:border-accent hover:text-ink"
        >
          <svg
            width="13"
            height="13"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            aria-hidden
          >
            <circle cx="11" cy="11" r="7" />
            <path d="m20 20-3.5-3.5" />
          </svg>
          <kbd className="num hidden rounded border border-line bg-surface2 px-1.5 py-0.5 text-[10px] sm:inline">
            ⌘K
          </kbd>
        </button>
        <button
          type="button"
          onClick={() => setMenuOpen((v) => !v)}
          aria-label={menuOpen ? "Close menu" : "Open menu"}
          aria-expanded={menuOpen}
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded border border-line bg-surface text-ink2 transition-colors hover:border-accent hover:text-ink sm:hidden"
        >
          <span className="relative block h-3 w-4" aria-hidden>
            <span
              className={`absolute left-0 top-0 block h-px w-4 bg-current transition-transform duration-200 ${
                menuOpen ? "translate-y-[5.5px] rotate-45" : ""
              }`}
            />
            <span
              className={`absolute left-0 top-[5.5px] block h-px w-4 bg-current transition-opacity duration-200 ${
                menuOpen ? "opacity-0" : ""
              }`}
            />
            <span
              className={`absolute left-0 top-[11px] block h-px w-4 bg-current transition-transform duration-200 ${
                menuOpen ? "-translate-y-[5.5px] -rotate-45" : ""
              }`}
            />
          </span>
        </button>
        <SearchPalette open={searchOpen} onOpenChange={setSearchOpen} />
      </div>
      {/* Mobile disclosure: grid-rows 0fr→1fr animates open, links mirror the desktop nav. */}
      <div
        className={`grid transition-[grid-template-rows] duration-200 ease-out sm:hidden ${
          menuOpen ? "grid-rows-[1fr]" : "grid-rows-[0fr]"
        }`}
      >
        <div className="overflow-hidden">
          <nav
            className={`flex flex-col gap-0.5 border-t border-line bg-surface px-4 transition-opacity duration-200 ${
              menuOpen ? "py-2 opacity-100" : "py-0 opacity-0"
            }`}
          >
            {LINKS.map((l) => (
              <Link
                key={l.href}
                href={l.href}
                tabIndex={menuOpen ? undefined : -1}
                className={`rounded px-3 py-2 text-sm transition-colors ${
                  isActive(l.href)
                    ? "bg-surface2 text-ink"
                    : "text-ink2 hover:bg-surface2 hover:text-ink"
                }`}
              >
                {l.label}
              </Link>
            ))}
          </nav>
        </div>
      </div>
    </header>
  );
}
