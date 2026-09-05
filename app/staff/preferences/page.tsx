import { AuthShell } from "@/components/auth/AuthShell";
import { StaffPreferenceClient } from "@/components/staff/StaffPreferenceClient";

export default function StaffPreferencesPage() {
  return (
    <AuthShell
      eyebrow="職員専用"
      title="希望休・希望勤務時間"
      description="対象月の日ごとの希望を保存し、内容を確認してから提出します。"
      showHomeLink={false}
    >
      <StaffPreferenceClient />
    </AuthShell>
  );
}
