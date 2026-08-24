"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { api, ApiError } from "@/lib/client/api";

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

export type Credential = {
  loginId: string;
  temporaryPassword: string;
  familyId?: string;
  administratorId?: string;
  role?: string;
  childNames?: string[];
  startDate?: string | null;
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
  const [liveValue, setLiveValue] = useState(value);
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
    setLiveValue(nextValue);
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
          defaultValue={value}
          onChange={(event) => updateValue(event.currentTarget.value)}
          onInput={(event) => updateValue(event.currentTarget.value)}
          autoCapitalize="none"
          spellCheck={false}
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
          {copyable ? <button type="button" className="password-action" onClick={() => void copyPassword()} disabled={!liveValue}>コピー</button> : null}
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
  const loginIdInputRef = useRef<HTMLInputElement>(null);
  const passwordInputRef = useRef<HTMLInputElement>(null);
  const [message, setMessage] = useState("");
  const [submitting, setSubmitting] = useState(false);

  function loginErrorMessage(error: unknown) {
    if (error instanceof ApiError) {
      if (error.code === "INVALID_CREDENTIALS") return "ログインIDまたはパスワードが正しくありません。";
      if (error.status >= 500) return "ログイン処理でエラーが発生しました。しばらくしてからもう一度お試しください。";
      return error.message;
    }
    return "通信に失敗しました。しばらくしてからもう一度お試しください。";
  }

  async function login(submittedLoginId: string, submittedPassword: string) {
    if (submitting) return;
    setMessage("");
    setSubmitting(true);
    try {
      const result = await api<{ redirectTo: string }>(`/api/auth/login/${scope}`, {
        method: "POST",
        body: { loginId: submittedLoginId, password: submittedPassword },
      });
      window.location.assign(result.redirectTo);
    } catch (error) {
      setMessage(loginErrorMessage(error));
      if (passwordInputRef.current) passwordInputRef.current.value = "";
      requestAnimationFrame(() => {
        if (loginIdInputRef.current) loginIdInputRef.current.value = submittedLoginId;
      });
    } finally {
      setSubmitting(false);
    }
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    const submittedLoginId = String(formData.get("username") ?? "");
    const submittedPassword = String(formData.get("password") ?? "");
    void login(submittedLoginId, submittedPassword);
  }

  return (
    <form
      className="auth-form"
      name={`${scope}-login`}
      autoComplete="on"
      onSubmit={submit}
      onKeyDown={(event) => {
        if (event.key !== "Enter" || submitting) return;
        event.preventDefault();
        event.currentTarget.requestSubmit();
      }}
    >
      <label htmlFor={`${scope}-login-id`}>
        <span>ログインID</span>
        <input ref={loginIdInputRef} id={`${scope}-login-id`} name="username" autoComplete="username" required />
      </label>
      <label htmlFor={`${scope}-login-password`}>
        <span>パスワード</span>
        <input ref={passwordInputRef} id={`${scope}-login-password`} name="password" type="password" autoComplete="current-password" required />
      </label>
      {message ? <p className="auth-message error" role="alert">{message}</p> : null}
      <button className="primary" type="button" onClick={(event) => event.currentTarget.form?.requestSubmit()} disabled={submitting}>{submitting ? "確認中..." : "ログイン"}</button>
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

function printFamilyLoginGuide(credential: Credential) {
  const popup = window.open("", "_blank", "width=760,height=900");
  if (!popup) throw new Error("ログイン案内を開けませんでした。ポップアップを許可してください。");
  popup.opener = null;
  const document = popup.document;
  document.title = "保護者用 利用予定表ログイン案内";
  const style = document.createElement("style");
  style.textContent = `body{font-family:"Yu Gothic",sans-serif;color:#17212b;margin:40px;line-height:1.7}main{max-width:680px;margin:auto}h1{font-size:26px;border-bottom:3px solid #28766b;padding-bottom:12px}dl{border:1px solid #b8c4c1;padding:20px}div{margin:12px 0}dt{font-size:13px;color:#52605e}dd{font-size:21px;font-weight:700;margin:2px 0;overflow-wrap:anywhere}.note{margin-top:28px;padding:16px;background:#f3f7f6}@page{size:A4;margin:18mm}@media print{button{display:none}}`;
  document.head.appendChild(style);
  const main = document.createElement("main");
  const title = document.createElement("h1");
  title.textContent = "保護者用 利用予定表ログイン案内";
  main.appendChild(title);
  const intro = document.createElement("p");
  intro.textContent = `${credential.childNames?.join("、") || "お子さま"}の利用予定入力に使用するログイン情報です。`;
  main.appendChild(intro);
  const list = document.createElement("dl");
  for (const [label, value] of [
    ["ログイン画面", `${window.location.origin}/auth/parent`],
    ["ログインID", credential.loginId],
    ["パスワード", credential.temporaryPassword],
    ["使用開始日", credential.startDate || "園へご確認ください"],
  ]) {
    const row = document.createElement("div");
    const term = document.createElement("dt");
    const description = document.createElement("dd");
    term.textContent = label;
    description.textContent = value;
    row.appendChild(term);
    row.appendChild(description);
    list.appendChild(row);
  }
  main.appendChild(list);
  const note = document.createElement("p");
  note.className = "note";
  note.textContent = "パスワードを忘れた場合は、園へご連絡ください。園から新しいパスワードを再発行します。";
  main.appendChild(note);
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = "印刷・PDFに保存";
  button.addEventListener("click", () => {
    try {
      popup.print();
    } catch {
      popup.alert("印刷画面を開けませんでした。ブラウザーの印刷機能をお試しください。");
    }
  });
  main.appendChild(button);
  document.body.appendChild(main);
  popup.focus();
}

export function CredentialNotice({ credential, onDismiss }: { credential: Credential; onDismiss: () => void }) {
  const isFamily = Boolean(credential.familyId);
  const passwordLabel = isFamily ? "園発行パスワード" : "初期・仮パスワード";
  return (
    <aside className="credential-notice" role="status">
      <div><strong>{passwordLabel}（この画面で一度だけ表示）</strong><button type="button" onClick={onDismiss}>閉じる</button></div>
      <dl><div><dt>ログインID</dt><dd>{credential.loginId}</dd></div><div><dt>{passwordLabel}</dt><dd className="credential-value">{credential.temporaryPassword}</dd></div></dl>
      {isFamily ? <button type="button" onClick={() => printFamilyLoginGuide(credential)}>ログイン案内を印刷・PDF保存</button> : null}
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
      <th><strong>{family.display_name}</strong></th>
      <td>{family.login_id}</td>
      <td><input type="date" value={handover} onChange={(event) => setHandover(event.target.value)} /><button type="button" onClick={() => perform(async () => { await api(`/api/admin/families/${family.id}/handover`, { method: "PATCH", body: { handedOverAt: handover } }); })}>使用開始日を保存</button></td>
      <td><input type="date" value={stopDate} onChange={(event) => setStopDate(event.target.value)} /><button type="button" onClick={() => perform(async () => { await api(`/api/admin/families/${family.id}/stop-date`, { method: "PATCH", body: { stopDate } }); })}>{stopDate ? "停止日を保存" : "停止日を解除"}</button></td>
      <td><button type="button" onClick={() => { if (window.confirm("園発行パスワードを再発行し、既存セッションを無効にしますか？")) void perform(async () => { const result = await api<{ credential: Credential }>(`/api/admin/families/${family.id}/reissue-password`, { method: "POST", body: {} }); showCredential(result.credential); }); }}>園発行パスワードを再発行</button></td>
    </tr>
  );
}

export function AdminAccountsView() {
  const [actor, setActor] = useState<Actor | null>(null);
  const [families, setFamilies] = useState<FamilyAccount[]>([]);
  const [administrators, setAdministrators] = useState<AdministratorAccount[]>([]);
  const [settings, setSettings] = useState<AuthSettings | null>(null);
  const [credential, setCredential] = useState<Credential | null>(null);
  const [message, setMessage] = useState("");
  const [criticalPassword, setCriticalPassword] = useState("");

  const reload = useCallback(async () => {
    const accounts = await api<{ actor: Actor; families: FamilyAccount[]; administrators: AdministratorAccount[]; settings: AuthSettings }>("/api/admin/accounts");
    setActor(accounts.actor);
    setFamilies(accounts.families);
    setAdministrators(accounts.administrators);
    setSettings(accounts.settings);
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void reload().catch((error) => setMessage(error instanceof Error ? error.message : "読み込めませんでした。"));
    }, 0);
    return () => window.clearTimeout(timer);
  }, [reload]);

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

  if (!actor || !settings) return <p className={`auth-message ${message ? "error" : "info"}`}>{message || "管理者情報を確認中..."}</p>;
  const isMaster = actor.role === "master";
  return (
    <div className="auth-stack">
      {credential ? <CredentialNotice credential={credential} onDismiss={() => setCredential(null)} /> : null}
      {message ? <p className="auth-message info" role="status">{message}</p> : null}

      <section className="auth-section"><div className="auth-section-heading"><div><span>{families.length}家庭</span><h2>保護者ログインアカウント管理</h2></div></div><p className="admin-schedule-note">新しい保護者ログインアカウントは、園児を登録した後に園児画面から発行します。</p><div className="auth-table-wrap"><table className="auth-table"><thead><tr><th>家庭</th><th>ログインID</th><th>使用開始日</th><th>停止日</th><th>認証</th></tr></thead><tbody>{families.map((family) => <FamilyRow key={family.id} family={family} reload={reload} showCredential={setCredential} setMessage={setMessage} />)}</tbody></table></div></section>

      <section className="auth-section"><div className="auth-section-heading"><div><span>通常管理者は通常権限のみ発行可能</span><h2>管理者アカウント発行</h2></div></div><form className="auth-inline-form" onSubmit={issueAdministrator}><label><span>表示名</span><input name="displayName" placeholder="管理者名" required /></label><label><span>ログインID</span><input name="loginId" placeholder="admin.sato" required /></label><label><span>権限</span><select name="role" defaultValue="normal"><option value="normal">通常管理者</option>{isMaster ? <option value="master">マスター管理者</option> : null}</select></label><button className="primary" type="submit">発行</button></form></section>

      {isMaster ? <section className="auth-section critical-section"><div className="auth-section-heading"><div><span>重要操作の直前に再確認</span><h2>現在のパスワード</h2></div></div><label className="critical-password" htmlFor="critical-current-password"><span>マスター管理者の現在のパスワード</span><input id="critical-current-password" name="criticalCurrentPassword" type="password" autoComplete="current-password" value={criticalPassword} onChange={(event) => setCriticalPassword(event.target.value)} /></label></section> : null}

      <section className="auth-section"><div className="auth-section-heading"><div><span>{administrators.length}名</span><h2>管理者アカウント管理</h2></div></div><div className="auth-table-wrap"><table className="auth-table"><thead><tr><th>管理者</th><th>権限</th><th>状態</th><th>操作</th></tr></thead><tbody>{administrators.map((administrator) => <tr key={administrator.id}><th><strong>{administrator.display_name}</strong></th><td>{administrator.role === "master" ? "マスター" : "通常"}</td><td>{administrator.status === "active" ? "有効" : "停止"}</td><td className="auth-actions">{isMaster && administrator.status === "active" ? <><button type="button" onClick={() => void administratorAction(`/api/admin/administrators/${administrator.id}/reissue-password`, "POST", { currentPassword: criticalPassword }, "仮パスワードを再発行し、既存セッションを無効にしますか？")}>再発行</button><button type="button" onClick={() => void administratorAction(`/api/admin/administrators/${administrator.id}/role`, "PATCH", { role: administrator.role === "master" ? "normal" : "master", currentPassword: criticalPassword }, "管理者権限を変更し、既存セッションを無効にしますか？")}>権限変更</button><button type="button" onClick={() => void administratorAction(`/api/admin/administrators/${administrator.id}/stop`, "PATCH", { currentPassword: criticalPassword }, "この管理者を停止しますか？")}>停止</button></> : <span>閲覧のみ</span>}</td></tr>)}</tbody></table></div></section>
    </div>
  );
}
