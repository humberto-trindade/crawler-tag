"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

type NavItem = {
  href: string;
  label: string;
};

const navItems: NavItem[] = [
  { href: "/", label: "Início Rápido" },
  { href: "/audits", label: "Execuções" },
  { href: "/history", label: "Histórico" },
  { href: "/templates", label: "Personas & Templates" },
  { href: "/settings", label: "Configurações de Crawl" },
  { href: "/analysis", label: "Análise" },
];

const isActivePath = (pathname: string, href: string) => {
  if (href === "/") {
    return pathname === "/";
  }
  return pathname === href || pathname.startsWith(`${href}/`);
};

export function AppNavigation() {
  const pathname = usePathname();

  return (
    <header className="border-b border-slate-200 bg-white">
      <div className="mx-auto flex max-w-7xl flex-col gap-3 px-4 py-4 md:px-6">
        <div className="flex items-center justify-between">
          <Link href="/" className="text-lg font-semibold text-slate-900">
            Crawler Tag
          </Link>
          <p className="text-xs text-slate-500">Auditoria de tracking client-side</p>
        </div>
        <nav className="overflow-x-auto">
          <ul className="flex min-w-max gap-2">
            {navItems.map((item) => {
              const active = isActivePath(pathname, item.href);
              return (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    className={`rounded-md px-3 py-2 text-sm ${
                      active ? "bg-slate-900 text-white" : "bg-slate-100 text-slate-700 hover:bg-slate-200"
                    }`}
                  >
                    {item.label}
                  </Link>
                </li>
              );
            })}
          </ul>
        </nav>
      </div>
    </header>
  );
}
