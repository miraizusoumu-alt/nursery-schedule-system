import { AuthShell } from "@/components/auth/AuthShell";
import { ParentAccountView } from "@/components/auth/AuthClient";

export default function ParentAccountPage() {
  return <AuthShell eyebrow="第2段階 認証確認" title="保護者ログインアカウント" description="サーバーで確認された自分の家庭情報だけを表示します。"><ParentAccountView /></AuthShell>;
}
