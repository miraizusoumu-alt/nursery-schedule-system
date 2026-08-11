import { AuthShell } from "@/components/auth/AuthShell";
import { LoginForm } from "@/components/auth/AuthClient";

export default function ParentLoginPage() {
  return <AuthShell eyebrow="家庭アカウント" title="保護者ログイン" description="園から受け取った家庭IDと初期・登録済みパスワードを入力してください。"><LoginForm scope="family" /></AuthShell>;
}
