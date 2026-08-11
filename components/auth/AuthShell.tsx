import type { ReactNode } from "react";
import Link from "next/link";

export function AuthShell({ eyebrow, title, description, children }: { eyebrow: string; title: string; description: string; children: ReactNode }) {
  return (
    <main className="auth-shell">
      <header className="auth-header">
        <div>
          <p className="eyebrow">{eyebrow}</p>
          <h1>{title}</h1>
          <p>{description}</p>
        </div>
        <Link className="text-link" href="/">試作トップへ</Link>
      </header>
      {children}
    </main>
  );
}
