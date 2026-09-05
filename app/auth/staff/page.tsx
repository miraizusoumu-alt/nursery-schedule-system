import { AuthShell } from "@/components/auth/AuthShell";
import { LoginForm } from "@/components/auth/AuthClient";

export default function StaffLoginPage() {
  return (
    <AuthShell
      eyebrow="職員専用"
      title="職員ログイン"
      description="園から受け取った職員ログインIDとパスワードを入力してください。"
    >
      <LoginForm scope="staff" />
    </AuthShell>
  );
}
