import { AuthShell } from "@/components/auth/AuthShell";
import { AdminScheduleClient } from "@/components/admin/AdminScheduleClient";

export default function AdminSchedulesPage() {
  return (
    <AuthShell
      eyebrow="第4A段階 利用予定管理"
      title="提出予定の確認・修正"
      description="対象月、家庭別期限、提出確認、園での修正履歴を管理します。"
    >
      <AdminScheduleClient />
    </AuthShell>
  );
}
