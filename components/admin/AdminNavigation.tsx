"use client";

import Link from "next/link";
import { AdminIcon } from "@/components/ui/AdminIcon";
import { LogoutButton } from "@/components/auth/AuthClient";

export type AdminPrimaryArea = "children" | "schedules" | "staff" | "shift" | "reports" | "accounts";

const scheduleAreas = [
  { area: "children", icon: "child", label: "園児" },
  { area: "schedules", icon: "calendar", label: "利用予定" },
  { area: "staff", icon: "staff", label: "職員" },
  { area: "shift", icon: "clock", label: "シフト" },
  { area: "reports", icon: "report", label: "集計・Excel" },
] as const;

export function AdminNavigation({
  activeArea,
  onSelect,
}: {
  activeArea: AdminPrimaryArea | null;
  onSelect?: (area: Exclude<AdminPrimaryArea, "accounts">) => void;
}) {
  return (
    <nav className="admin-area-tabs" aria-label="園の運営管理">
      {scheduleAreas.map(({ area, icon, label }) => (
        onSelect ? (
          <button key={area} type="button" className={activeArea === area ? "active" : ""} aria-current={activeArea === area ? "page" : undefined} onClick={() => onSelect(area)}>
            <AdminIcon name={icon} />{label}
          </button>
        ) : (
          <Link key={area} className={activeArea === area ? "active" : ""} aria-current={activeArea === area ? "page" : undefined} href={`/admin/schedules?area=${area}`}>
            <AdminIcon name={icon} />{label}
          </Link>
        )
      ))}
      <Link className={activeArea === "accounts" ? "active" : ""} aria-current={activeArea === "accounts" ? "page" : undefined} href="/admin/accounts">
        <AdminIcon name="account" />アカウント
      </Link>
      <span className="admin-nav-logout"><LogoutButton /></span>
    </nav>
  );
}
