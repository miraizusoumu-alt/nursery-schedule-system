import { AuthShell } from "@/components/auth/AuthShell";
import { AdminScheduleClient } from "@/components/admin/AdminScheduleClient";

export default function AdminSchedulesPage() {
  return (
    <AuthShell
      eyebrow="正式な管理画面"
      title="園の運営管理"
      description="園児、利用予定、職員、集計、アカウントを目的別に管理できます。"
      showHomeLink={false}
    >
      <AdminScheduleClient />
    </AuthShell>
  );
}
