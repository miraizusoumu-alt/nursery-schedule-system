import { AuthShell } from "@/components/auth/AuthShell";
import { ParentScheduleClient } from "@/components/parent/ParentScheduleClient";

export default function ParentSchedulePage() {
  return (
    <AuthShell
      eyebrow="第3段階 利用予定入力"
      title="利用予定の入力・提出"
      description="提出対象月だけを表示し、同じ家庭の園児分をまとめて提出します。"
    >
      <ParentScheduleClient />
    </AuthShell>
  );
}
