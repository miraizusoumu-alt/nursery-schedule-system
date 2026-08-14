"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { api } from "@/lib/client/api";

type Actor = {
  type: "family" | "administrator";
  id: string;
  familyId: string | null;
  role: "normal" | "master" | null;
  displayName: string;
  loginId: string;
  mustChangePassword: boolean;
};

type FamilyAccount = {
  id: string;
  family_code: string;
  display_name: string;
  issued_at: string | null;
  handed_over_at: string | null;
  stop_date: string | null;
  account_id: string;
  login_id: string;
  must_change_password: number;
  last_login_at: string | null;
};

type AdministratorAccount = {
  id: string;
  login_id: string;
  display_name: string;
  role: "normal" | "master";
  status: "active" | "stopped";
  must_change_password: number;
  created_at: string;
  stopped_at: string | null;
};

type Credential = {
  loginId: string;
  temporaryPassword: string;
  role?: string;
};

type AuthSettings = {
  loginFailureLimit: number;
  loginWindowMinutes: number;
  loginLockMinutes: number;
  familySessionMinutes: number;
  administratorSessionMinutes: number;
  passwordMinimumLength: number;
  secureCookies: boolean;
};

async function copyPasswordToClipboard(value: string) {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(value);
      return;
    } catch {
      // Local HTTP testing may not expose the modern Clipboard API.
    }
  }

  const textarea = document.createElement("textarea");
  const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  textarea.value = value;
  textarea.readOnly = true;
  textarea.setAttribute("aria-hidden", "true");
  textarea.style.position = "fixed";
  textarea.style.inset = "-9999px auto auto -9999px";
  document.body.appendChild(textarea);
  textarea.select();
  const copied = document.execCommand("copy");
  textarea.remove();
  previouslyFocused?.focus({ preventScroll: true });
  if (!copied) throw new Error("COPY_FAILED");
}

function PasswordField({
  id,
  name,
  label,
  value,
  onValueChange,
  autoComplete,
  minLength,
  maxLength,
  copyable = false,
}: {
  id: string;
  name: string;
  label: string;
  value: string;
  onValueChange: (value: string) => void;
  autoComplete: "current-password" | "new-password";
  minLength?: number;
  maxLength?: number;
  copyable?: boolean;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [visible, setVisible] = useState(false);
  const [copyStatus, setCopyStatus] = useState<"" | "copied" | "failed">("");

  function toggleVisibility() {
    const input = inputRef.current;
    const selectionStart = input?.selectionStart ?? null;
    const selectionEnd = input?.selectionEnd ?? null;
    setVisible((current) => !current);
    requestAnimationFrame(() => {
      const nextInput = inputRef.current;
      nextInput?.focus({ preventScroll: true });
      if (selectionStart !== null && selectionEnd !== null) nextInput?.setSelectionRange(selectionStart, selectionEnd);
    });
  }

  async function copyPassword() {
    const currentValue = inputRef.current?.value ?? value;
    if (!currentValue) return;
    try {
      await copyPasswordToClipboard(currentValue);
      setCopyStatus("copied");
    } catch {
      setCopyStatus("failed");
    }
  }

  function updateValue(nextValue: string) {
    setCopyStatus("");
    onValueChange(nextValue);
  }

  return (
    <div className="password-field">
      <label htmlFor={id}>{label}</label>
      <div className="password-control">
        <input
          ref={inputRef}
          id={id}
          name={name}
          type={visible ? "text" : "password"}
          autoComplete={autoComplete}
          minLength={minLength}
          maxLength={maxLength}
          value={value}
          onChange={(event) => updateValue(event.currentTarget.value)}
          required
        />
        <div className="password-field-actions">
          <button
            type="button"
            className="password-action"
            aria-controls={id}
            aria-pressed={visible}
            aria-label={`${label}を${visible ? "隠す" : "表示する"}`}
            onClick={toggleVisibility}
          >
            {visible ? "隠す" : "表示する"}
          </button>
          {copyable ? <button type="button" className="password-action" onClick={() => void copyPassword()} disabled={!value}>コピー</button> : null}
        </div>
      </div>
      {copyable && copyStatus ? (
        <span className={`password-copy-status ${copyStatus === "failed" ? "error" : ""}`} role={copyStatus === "failed" ? "alert" : "status"} aria-live="polite">
          {copyStatus === "copied" ? "コピーしました" : "コピーできませんでした。ブラウザの設定を確認してください。"}
        </span>
      ) : null}
    </div>
  );
}

export function LoginForm({ scope }: { scope: "family" | "admin" }) {
  const [loginId, setLoginId] = useState("");
  const [password, setPassword] = useState("");
  const [message, setMessage] = useState("");
  const [submitting, setSubmitting] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setMessage("");
    setSubmitting(true);
    try {
      const result = await api<{ redirectTo: string }>(`/api/auth/login/${scope}`, { method: "POST", body: { loginId, password } });
      window.location.assign(result.redirectTo);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "ログインできませんでした。");
      setPassword("");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form className="auth-form" name={`${scope}-login`} autoComplete="on" onSubmit={submit}>
      <label htmlFor={`${scope}-login-id`}>
        <span>ログインID</span>
        <input id={`${scope}-login-id`} name="username" autoComplete="username" value={loginId} onChange={(event) => setLoginId(event.target.value)} required />
      </label>
      <label htmlFor={`${scope}-login-password`}>
        <span>パスワード</span>
        <input id={`${scope}-login-password`} name="password" type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} required />
      </label>
      {message ? <p className="auth-message error" role="alert">{message}</p> : null}
      <button className="primary" type="submit" disabled={submitting}>{submitting ? "確認中..." : "ログイン"}</button>
    </form>
  );
}

export function PasswordChangeForm() {
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [message, setMessage] = useState("");
  const [submitting, setSubmitting] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    const submittedCurrentPassword = String(formData.get("currentPassword") ?? "");
    const submittedNewPassword = String(formData.get("newPassword") ?? "");
    const submittedConfirmation = String(formData.get("newPasswordConfirmation") ?? "");
    setCurrentPassword(submittedCurrentPassword);
    setNewPassword(submittedNewPassword);
    setConfirmation(submittedConfirmation);
    setMessage("");
    if (submittedNewPassword.length < 8 || submittedNewPassword.length > 128) {
      setMessage("新しいパスワードは8文字以上・128文字以下で入力してください。");
      return;
    }
    if (submittedNewPassword !== submittedConfirmation) {
      setMessage("新しいパスワードが一致しません。");
      return;
    }
    setSubmitting(true);
    try {
      const result = await api<{ redirectTo: string }>("/api/auth/change-password", {
        method: "POST",
        body: { currentPassword: submittedCurrentPassword, newPassword: submittedNewPassword },
      });
      window.location.assign(result.redirectTo);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "変更できませんでした。");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form id="password-change-form" name="password-change" className="auth-form" autoComplete="on" onSubmit={submit}>
      <p className="auth-message info">新しいパスワードは、英字・数字・記号を使用して8文字以上・128文字以下で設定してください。</p>
      <PasswordField id="current-password" name="currentPassword" label="現在のパスワード" value={currentPassword} onValueChange={(value) => { setCurrentPassword(value); setMessage(""); }} autoComplete="current-password" />
      <PasswordField id="new-password" name="newPassword" label="新しいパスワード" value={newPassword} onValueChange={(value) => { setNewPassword(value); setMessage(""); }} autoComplete="new-password" minLength={8} maxLength={128} copyable />
      <PasswordField id="new-password-confirmation" name="newPasswordConfirmation" label="新しいパスワード（確認）" value={confirmation} onValueChange={(value) => { setConfirmation(value); setMessage(""); }} autoComplete="new-password" minLength={8} maxLength={128} />
      {message ? <p className="auth-message error" role="alert">{message}</p> : null}
      <button className="primary" type="submit" disabled={submitting}>{submitting ? "変更中..." : "パスワードを変更"}</button>
    </form>
  );
}

export function LogoutButton() {
  const [submitting, setSubmitting] = useState(false);
  async function logout() {
    setSubmitting(true);
    try {
      await api("/api/auth/logout", { method: "POST", body: {} });
      window.location.assign("/");
    } finally {
      setSubmitting(false);
    }
  }
  return <button type="button" onClick={logout} disabled={submitting}>{submitting ? "ログアウト中..." : "ログアウト"}</button>;
}

export function ParentAccountView() {
  const [data, setData] = useState<{ family: FamilyAccount; children: Array<{ id: string; child_code: string; name: string; class_name: string }> } | null>(null);
  const [message, setMessage] = useState("");
  useEffect(() => {
    api<{ family: FamilyAccount; children: Array<{ id: string; child_code: string; name: string; class_name: string }> }>("/api/family/me")
      .then(setData)
      .catch((error) => setMessage(error instanceof Error ? error.message : "読み込めませんでした。"));
  }, []);
  if (message) return <p className="auth-message error">{message}</p>;
  if (!data) return <p className="auth-message info">確認中...</p>;
  return (
    <div className="auth-stack">
      <section className="auth-section">
        <div className="auth-section-heading"><div><span>認証済み家庭</span><h2>{data.family.display_name}</h2></div><LogoutButton /></div>
        <dl className="auth-details">
          <div><dt>家庭コード</dt><dd>{data.family.family_code}</dd></div>
          <div><dt>ログインID</dt><dd>{data.family.login_id}</dd></div>
          <div><dt>発行日</dt><dd>{data.family.issued_at?.slice(0, 10) ?? "未記録"}</dd></div>
          <div><dt>受渡日</dt><dd>{data.family.handed_over_at ?? "未記録"}</dd></div>
        </dl>
      </section>
      <section className="auth-section">
        <div className="auth-section-heading"><div><span>この家庭に紐づく園児のみ</span><h2>園児一覧</h2></div></div>
        {data.children.length ? <ul className="auth-list">{data.children.map((child) => <li key={child.id}><strong>{child.name}</strong><span>{child.class_name || child.child_code}</span></li>)}</ul> : <p>現在紐づいている園児はいません。</p>}
      </section>
      <p className="auth-message info"><a className="text-link" href="/parent/schedule">利用予定の入力・提出へ進む</a></p>
    </div>
  );
}

function CredentialNotice({ credential, onDismiss }: { credential: Credential; onDismiss: () => void }) {
  return (
    <aside className="credential-notice" role="status">
      <div><strong>初期・仮パスワード（この画面で一度だけ表示）</strong><button type="button" onClick={onDismiss}>閉じる</button></div>
      <dl><div><dt>ログインID</dt><dd>{credential.loginId}</dd></div><div><dt>初期・仮パスワード</dt><dd className="credential-value">{credential.temporaryPassword}</dd></div></dl>
    </aside>
  );
}

function FamilyRow({ family, reload, showCredential, setMessage }: { family: FamilyAccount; reload: () => Promise<void>; showCredential: (value: Credential) => void; setMessage: (value: string) => void }) {
  const [handover, setHandover] = useState(family.handed_over_at ?? "");
  const [stopDate, setStopDate] = useState(family.stop_date ?? "");
  async function perform(run: () => Promise<void>) {
    try { await run(); await reload(); } catch (error) { setMessage(error instanceof Error ? error.message : "処理できませんでした。"); }
  }
  return (
    <tr>
      <th><strong>{family.display_name}</strong><span>{family.family_code}</span></th>
      <td>{family.login_id}</td>
      <td><input type="date" value={handover} onChange={(event) => setHandover(event.target.value)} /><button type="button" onClick={() => perform(async () => { await api(`/api/admin/families/${family.id}/handover`, { method: "PATCH", body: { handedOverAt: handover } }); })}>受渡日を保存</button></td>
      <td><input type="date" value={stopDate} onChange={(event) => setStopDate(event.target.value)} /><button type="button" onClick={() => perform(async () => { await api(`/api/admin/families/${family.id}/stop-date`, { method: "PATCH", body: { stopDate } }); })}>{stopDate ? "停止日を保存" : "停止日を解除"}</button></td>
      <td><button type="button" onClick={() => { if (window.confirm("仮パスワードを再発行し、既存セッションを無効にしますか？")) void perform(async () => { const result = await api<{ credential: Credential }>(`/api/admin/families/${family.id}/reissue-password`, { method: "POST", body: {} }); showCredential(result.credential); }); }}>仮パスワード再発行</button></td>
    </tr>
  );
}

export function AdminAccountsView() {
  const [actor, setActor] = useState<Actor | null>(null);
  const [families, setFamilies] = useState<FamilyAccount[]>([]);
  const [administrators, setAdministrators] = useState<AdministratorAccount[]>([]);
  const [settings, setSettings] = useState<AuthSettings | null>(null);
  const [logs, setLogs] = useState<Array<{ id: string; operation: string; occurred_at: string; target_type: string }>>([]);
  const [credential, setCredential] = useState<Credential | null>(null);
  const [message, setMessage] = useState("");
  const [criticalPassword, setCriticalPassword] = useState("");

  const reload = useCallback(async () => {
    const [accounts, history] = await Promise.all([
      api<{ actor: Actor; families: FamilyAccount[]; administrators: AdministratorAccount[]; settings: AuthSettings }>("/api/admin/accounts"),
      api<{ logs: Array<{ id: string; operation: string; occurred_at: string; target_type: string }> }>("/api/admin/operation-logs?limit=30"),
    ]);
    setActor(accounts.actor);
    setFamilies(accounts.families);
    setAdministrators(accounts.administrators);
    setSettings(accounts.settings);
    setLogs(history.logs);
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void reload().catch((error) => setMessage(error instanceof Error ? error.message : "読み込めませんでした。"));
    }, 0);
    return () => window.clearTimeout(timer);
  }, [reload]);

  async function issueFamily(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const values = Object.fromEntries(new FormData(form));
    try {
      const result = await api<{ credential: Credential }>("/api/admin/families", { method: "POST", body: values });
      setCredential(result.credential); setMessage("家庭アカウントを発行しました。"); form.reset(); await reload();
    } catch (error) { setMessage(error instanceof Error ? error.message : "発行できませんでした。"); }
  }

  async function issueAdministrator(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const values = Object.fromEntries(new FormData(form));
    try {
      const result = await api<{ credential: Credential }>("/api/admin/administrators", { method: "POST", body: { ...values, currentPassword: criticalPassword } });
      setCredential(result.credential); setMessage("管理者アカウントを発行しました。"); form.reset(); setCriticalPassword(""); await reload();
    } catch (error) { setMessage(error instanceof Error ? error.message : "発行できませんでした。"); }
  }

  async function administratorAction(path: string, method: string, body: unknown, confirmation: string) {
    if (!window.confirm(confirmation)) return;
    try {
      const result = await api<{ credential?: Credential }>(path, { method, body });
      if (result.credential) setCredential(result.credential);
      setMessage("管理者アカウントを更新しました。"); setCriticalPassword(""); await reload();
    } catch (error) { setMessage(error instanceof Error ? error.message : "更新できませんでした。"); }
  }

  async function saveSettings(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!settings) return;
    try {
      await api("/api/admin/auth-settings", { method: "PATCH", body: { settings, currentPassword: criticalPassword } });
      setMessage("認証設定を保存しました。"); setCriticalPassword(""); await reload();
    } catch (error) { setMessage(error instanceof Error ? error.message : "保存できませんでした。"); }
  }

  if (!actor || !settings) return <p className={`auth-message ${message ? "error" : "info"}`}>{message || "管理者情報を確認中..."}</p>;
  const isMaster = actor.role === "master";
  return (
    <div className="auth-stack">
      <section className="auth-section auth-toolbar"><div><span>ログイン中</span><strong>{actor.displayName}（{isMaster ? "マスター管理者" : "通常管理者"}）</strong></div><div className="admin-schedule-nav"><a href="/admin/schedules">利用予定管理</a><LogoutButton /></div></section>
      {credential ? <CredentialNotice credential={credential} onDismiss={() => setCredential(null)} /> : null}
      {message ? <p className="auth-message info" role="status">{message}</p> : null}

      <section className="auth-section"><div className="auth-section-heading"><div><span>初期パスワードは一度だけ表示</span><h2>家庭アカウント発行</h2></div></div><form className="auth-inline-form" onSubmit={issueFamily}><label><span>家庭コード</span><input name="familyCode" placeholder="DEMO-FAMILY-101" required /></label><label><span>家庭表示名</span><input name="displayName" placeholder="架空 認証確認家庭" required /></label><label><span>ログインID</span><input name="loginId" placeholder="demo-family-user" required /></label><button className="primary" type="submit">発行</button></form></section>

      <section className="auth-section"><div className="auth-section-heading"><div><span>{families.length}家庭</span><h2>家庭アカウント管理</h2></div></div><div className="auth-table-wrap"><table className="auth-table"><thead><tr><th>家庭</th><th>ログインID</th><th>受渡日</th><th>停止日</th><th>認証</th></tr></thead><tbody>{families.map((family) => <FamilyRow key={family.id} family={family} reload={reload} showCredential={setCredential} setMessage={setMessage} />)}</tbody></table></div></section>

      <section className="auth-section"><div className="auth-section-heading"><div><span>通常管理者は通常権限のみ発行可能</span><h2>管理者アカウント発行</h2></div></div><form className="auth-inline-form" onSubmit={issueAdministrator}><label><span>表示名</span><input name="displayName" placeholder="架空 管理者" required /></label><label><span>ログインID</span><input name="loginId" placeholder="demo-admin-user" required /></label><label><span>権限</span><select name="role" defaultValue="normal"><option value="normal">通常管理者</option>{isMaster ? <option value="master">マスター管理者</option> : null}</select></label><button className="primary" type="submit">発行</button></form></section>

      {isMaster ? <section className="auth-section critical-section"><div className="auth-section-heading"><div><span>重要操作の直前に再確認</span><h2>現在のパスワード</h2></div></div><label className="critical-password" htmlFor="critical-current-password"><span>マスター管理者の現在のパスワード</span><input id="critical-current-password" name="criticalCurrentPassword" type="password" autoComplete="current-password" value={criticalPassword} onChange={(event) => setCriticalPassword(event.target.value)} /></label></section> : null}

      <section className="auth-section"><div className="auth-section-heading"><div><span>{administrators.length}名</span><h2>管理者アカウント管理</h2></div></div><div className="auth-table-wrap"><table className="auth-table"><thead><tr><th>管理者</th><th>権限</th><th>状態</th><th>操作</th></tr></thead><tbody>{administrators.map((administrator) => <tr key={administrator.id}><th><strong>{administrator.display_name}</strong><span>{administrator.login_id}</span></th><td>{administrator.role === "master" ? "マスター" : "通常"}</td><td>{administrator.status === "active" ? "有効" : "停止"}</td><td className="auth-actions">{isMaster && administrator.status === "active" ? <><button type="button" onClick={() => void administratorAction(`/api/admin/administrators/${administrator.id}/reissue-password`, "POST", { currentPassword: criticalPassword }, "仮パスワードを再発行し、既存セッションを無効にしますか？")}>再発行</button><button type="button" onClick={() => void administratorAction(`/api/admin/administrators/${administrator.id}/role`, "PATCH", { role: administrator.role === "master" ? "normal" : "master", currentPassword: criticalPassword }, "管理者権限を変更し、既存セッションを無効にしますか？")}>権限変更</button><button type="button" onClick={() => void administratorAction(`/api/admin/administrators/${administrator.id}/stop`, "PATCH", { currentPassword: criticalPassword }, "この管理者を停止しますか？")}>停止</button></> : <span>閲覧のみ</span>}</td></tr>)}</tbody></table></div></section>

      {isMaster ? <section className="auth-section"><div className="auth-section-heading"><div><span>値は仕様より弱くできません</span><h2>重要な認証設定</h2></div></div><form className="settings-grid" onSubmit={saveSettings}><label><span>失敗回数上限</span><input type="number" min={3} max={5} value={settings.loginFailureLimit} onChange={(event) => setSettings({ ...settings, loginFailureLimit: Number(event.target.value) })} /></label><label><span>制限時間（分）</span><input type="number" min={15} max={120} value={settings.loginLockMinutes} onChange={(event) => setSettings({ ...settings, loginLockMinutes: Number(event.target.value) })} /></label><label><span>保護者保持（分）</span><input type="number" min={60} max={43200} value={settings.familySessionMinutes} onChange={(event) => setSettings({ ...settings, familySessionMinutes: Number(event.target.value) })} /></label><label><span>管理者保持（分）</span><input type="number" min={15} max={480} value={settings.administratorSessionMinutes} onChange={(event) => setSettings({ ...settings, administratorSessionMinutes: Number(event.target.value) })} /></label><label><span>最小パスワード長</span><input type="number" min={8} max={64} value={settings.passwordMinimumLength} onChange={(event) => setSettings({ ...settings, passwordMinimumLength: Number(event.target.value) })} /></label><button className="primary" type="submit">設定を保存</button></form></section> : null}

      <section className="auth-section"><div className="auth-section-heading"><div><span>直近{logs.length}件</span><h2>認証操作履歴</h2></div></div><ul className="operation-list">{logs.map((log) => <li key={log.id}><strong>{log.operation}</strong><span>{log.target_type} / {new Date(log.occurred_at).toLocaleString("ja-JP")}</span></li>)}</ul></section>
    </div>
  );
}
