import { AuthShell } from "@/components/auth/AuthShell";
import { LoginForm } from "@/components/auth/AuthClient";

export default function ParentLoginPage() {
  return <AuthShell eyebrow="保護者ログインアカウント" title="保護者ログイン" description="園から受け取ったログインIDと園発行パスワードを入力してください。"><LoginForm scope="family" /></AuthShell>;
}
