import type { ReactNode } from "react";

type AdminIconName = "overview" | "child" | "calendar" | "staff" | "clock" | "account" | "badge" | "save" | "history" | "report" | "download";

const paths: Record<AdminIconName, ReactNode> = {
  overview: <><rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" /><rect x="3" y="14" width="7" height="7" rx="1" /><rect x="14" y="14" width="7" height="7" rx="1" /></>,
  child: <><circle cx="12" cy="8" r="3" /><path d="M5 21v-2a7 7 0 0 1 14 0v2" /><path d="M8 5.5C8.6 3.8 10 3 12 3s3.4.8 4 2.5" /></>,
  calendar: <><rect x="3" y="5" width="18" height="16" rx="2" /><path d="M16 3v4M8 3v4M3 10h18" /><path d="M8 14h.01M12 14h.01M16 14h.01M8 18h.01M12 18h.01" /></>,
  staff: <><circle cx="9" cy="8" r="3" /><path d="M3 21v-2a6 6 0 0 1 12 0v2" /><circle cx="17" cy="9" r="2.5" /><path d="M16 15a5 5 0 0 1 5 5v1" /></>,
  clock: <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>,
  account: <><circle cx="9" cy="8" r="3" /><path d="M3 20v-1a6 6 0 0 1 12 0v1" /><path d="M17 8h4M19 6v4M16 14h5M16 18h5" /></>,
  badge: <><circle cx="12" cy="8" r="5" /><path d="m9 13-1 8 4-2 4 2-1-8" /><path d="m10.2 8 1.2 1.2L14 6.8" /></>,
  save: <><path d="M5 3h12l2 2v16H5z" /><path d="M8 3v6h8V3M8 16l2.5 2.5L16 13" /></>,
  history: <><path d="M3 12a9 9 0 1 0 3-6.7L3 8" /><path d="M3 3v5h5M12 7v5l3 2" /></>,
  report: <><path d="M4 20V10M10 20V4M16 20v-7M22 20H2" /></>,
  download: <><path d="M12 3v12M7 10l5 5 5-5" /><path d="M4 21h16" /></>,
};

export function AdminIcon({ name, size = 20 }: { name: AdminIconName; size?: number }) {
  return (
    <svg className="admin-icon" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {paths[name]}
    </svg>
  );
}
