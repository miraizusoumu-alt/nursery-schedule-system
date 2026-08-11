import { AuthShell } from "@/components/auth/AuthShell";
import { PasswordChangeForm } from "@/components/auth/AuthClient";

export default function PasswordChangePage() {
  return <AuthShell eyebrow="パスワード設定" title="パスワード変更" description="初回・仮パスワード・通常変更に共通の画面です。変更すると、それまでのセッションはすべて無効になります。"><PasswordChangeForm /></AuthShell>;
}
