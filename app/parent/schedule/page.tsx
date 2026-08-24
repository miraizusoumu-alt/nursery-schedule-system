import { AuthShell } from "@/components/auth/AuthShell";
import { ParentScheduleClient } from "@/components/parent/ParentScheduleClient";

export default function ParentSchedulePage() {
  return (
    <AuthShell
      eyebrow="翌月の利用予定"
      title="利用予定の入力・提出"
      description="対象月の予定を園児ごとに入力し、家庭分をまとめて提出できます。"
      showHomeLink={false}
    >
      <ParentScheduleClient />
    </AuthShell>
  );
}
