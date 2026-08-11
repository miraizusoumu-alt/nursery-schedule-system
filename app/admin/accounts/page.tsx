import { AuthShell } from "@/components/auth/AuthShell";
import { AdminAccountsView } from "@/components/auth/AuthClient";

export default function AdminAccountsPage() {
  return <AuthShell eyebrow="第2段階 認証・権限" title="アカウント管理" description="家庭アカウントと管理者アカウントの発行・再発行・停止を権限に応じて行います。"><AdminAccountsView /></AuthShell>;
}
