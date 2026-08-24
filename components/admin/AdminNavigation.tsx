"use client";

import Link from "next/link";
import { AdminIcon } from "@/components/ui/AdminIcon";
import { LogoutButton } from "@/components/auth/AuthClient";

export type AdminPrimaryArea = "children" | "schedules" | "staff" | "reports" | "accounts";

const scheduleAreas = [
  { area: "children", icon: "child", label: "園児" },
  { area: "schedules", icon: "calendar", label: "利用予定" },
  { area: "staff", icon: "staff", label: "職員" },
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
      {scheduleAreas.slice(0, 3).map(({ area, icon, label }) => (
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
      <span className="admin-nav-disabled" aria-disabled="true" title="シフト作成は次の開発段階で追加します">
        <AdminIcon name="clock" />シフト
      </span>
      {scheduleAreas.slice(3).map(({ area, icon, label }) => (
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
