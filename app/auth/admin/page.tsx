import { AuthShell } from "@/components/auth/AuthShell";
import { LoginForm } from "@/components/auth/AuthClient";

export default function AdministratorLoginPage() {
  return <AuthShell eyebrow="園管理者専用" title="管理者ログイン" description="通常管理者またはマスター管理者のログインIDを使用します。"><LoginForm scope="admin" /></AuthShell>;
}
