import { AuthShell } from "@/components/auth/AuthShell";
import { AdminAccountsView } from "@/components/auth/AuthClient";
import { AdminNavigation } from "@/components/admin/AdminNavigation";

export default function AdminAccountsPage() {
  return (
    <AuthShell eyebrow="正式な管理画面" title="園の運営管理" description="保護者ログインアカウントと管理者アカウントを、園の管理機能から続けて操作できます。" showHomeLink={false}>
      <AdminNavigation activeArea="accounts" />
      <AdminAccountsView />
    </AuthShell>
  );
}
