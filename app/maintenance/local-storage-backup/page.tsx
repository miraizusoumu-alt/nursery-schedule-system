"use client";

import { useEffect, useState } from "react";
import {
  STORAGE_BACKUP_KEY,
  STORAGE_KEY,
  backupPrototypeStoreOnce,
  inspectPrototypeStoreBackup,
  type PrototypeStoreBackupResult,
} from "@/lib/storage/local-storage";

function statusText(result: PrototypeStoreBackupResult | null) {
  if (!result) return "確認中";
  if (result.status === "ready") return "一回退避を実行できます";
  if (result.status === "created") return "退避と照合が完了しました";
  if (result.status === "already-backed-up") return "一度だけの退避がすでにあります";
  if (result.status === "no-source") return "退避対象の保存データはありません";
  return "退避を確認できませんでした";
}

export default function LocalStorageBackupPage() {
  const [result, setResult] = useState<PrototypeStoreBackupResult | null>(null);

  useEffect(() => {
    let active = true;
    const inspection = inspectPrototypeStoreBackup(window.localStorage);
    queueMicrotask(() => {
      if (active) setResult(inspection);
    });
    return () => {
      active = false;
    };
  }, []);

  function createBackup() {
    const ok = window.confirm("現在のlocalStorageデータを、内容を変えずに一度だけ別キーへ退避します。よろしいですか？");
    if (!ok) return;
    setResult(backupPrototypeStoreOnce(window.localStorage));
  }

  const canCreate = Boolean(result?.sourceExists && !result.backupExists);
  return (
    <main className="app-shell parent-mode">
      <header className="hero-band">
        <div>
          <p className="eyebrow">ローカル試作データ保護</p>
          <h1>localStorage一回退避</h1>
          <p className="hero-copy">元データは変更・削除せず、同じブラウザ内の別キーへJSONをそのまま保存します。</p>
        </div>
      </header>
      <section className="summary-card">
        <div className="section-title">
          <span>確認結果</span>
          <h2>{statusText(result)}</h2>
        </div>
        <div className="stats-grid">
          <div>
            <span>元の保存キー</span>
            <strong>{STORAGE_KEY}</strong>
          </div>
          <div>
            <span>退避先キー</span>
            <strong>{STORAGE_BACKUP_KEY}</strong>
          </div>
          <div>
            <span>元データ</span>
            <strong>{result?.sourceExists ? "あり" : "なし"}</strong>
          </div>
          <div>
            <span>退避データ</span>
            <strong>{result?.backupExists ? (result.verified ? "照合済み" : "要確認") : "なし"}</strong>
          </div>
        </div>
        {result?.createdAt ? <p className="mini-note">退避日時：{new Date(result.createdAt).toLocaleString("ja-JP")}</p> : null}
        <button type="button" className="primary" disabled={!canCreate} onClick={createBackup}>
          現在のJSONを一度だけ退避する
        </button>
      </section>
    </main>
  );
}
