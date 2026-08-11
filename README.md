# 保護者向け利用予定提出システム 試作版

企業主導型保育園で、保護者が翌月の利用予定を提出し、園側が月ごとの予定を確認するための試作版です。現在は架空データだけを使用します。

## 必要な環境

- Node.js 22.16以上
- npm
- Windows上のローカル確認を想定

## アプリの起動

```powershell
npm install
npm run dev
```

PCでは `http://localhost:3000/` を開きます。第1段階では画面の予定データは従来どおり`localStorage`を使用し、SQLiteへ自動移行しません。

## 第1段階のSQLite構成

- DB定義：`db/schema.ts`
- SQLマイグレーション：`drizzle/*.sql`
- Node.js用SQLite処理：`db/sqlite.mjs`
- 架空seed：`db/seed.mjs`
- バックアップ・復元：`db/maintenance.mjs`
- 標準DB：`local-data/nursery-schedule.sqlite`

Node.js標準の`node:sqlite`を使用するため、追加のネイティブパッケージや外部DBは必要ありません。スキーマは既存のDrizzleで管理し、SQLite互換SQLを生成します。今回はCloudflare D1へ接続しません。

## DBの作成と架空seed

```powershell
npm run db:migrate
npm run db:seed
npm run db:status
```

`db:seed`が登録するのは、IDと名称に`demo`または「架空」を含む開発用データだけです。複数回実行しても同じIDを更新するため、家庭・園児・基本利用時間などが重複しません。パスワードは登録しません。

## DBバックアップ

```powershell
npm run db:backup
```

`backups/database/`へ、`YYYYMMDD-HHmmss-SSS_manual-backup.sqlite`形式で保存します。バックアップ後にSQLiteの整合性と必要テーブルを自動確認します。

## DB復元

復元元ファイルを必ず明示します。

```powershell
npm run db:restore -- --file "C:\\確認した場所\\YYYYMMDD-HHmmss-SSS_manual-backup.sqlite"
```

復元前に、現在のDBを`YYYYMMDD-HHmmss-SSS_pre-restore.sqlite`として自動退避します。復元元がSQLiteとして正常で、必要テーブルをすべて含むことを確認してから置き換えます。現在のDB自身、存在しないファイル、SQLite以外の拡張子は指定できません。

## 既存localStorageの一回退避

アプリ起動後、同じブラウザで次を開きます。

`http://localhost:3000/maintenance/local-storage-backup`

［現在のJSONを一度だけ退避する］を押すと、元の`nursery-schedule-prototype-v2`を変更せず、`nursery-schedule-prototype-v2-original-backup-once`へJSON文字列をそのまま保存して照合します。退避先がすでに存在する場合は上書きしないため、二重退避や無限増加は起きません。

この退避もブラウザ内のデータです。SQLiteバックアップとは別であり、異なる端末やブラウザとは共有されません。

## 職員・シフト試作

職員希望休・シフト支援は、通常の役割切替と管理者メニューから開ける試作機能です。既存コードと`localStorage`データをそのまま使用し、第1段階のSQLiteには接続・移行していません。

## Gitへ保存しないもの

`.gitignore`で次を除外しています。

- `node_modules`
- `.env`、`.dev.vars`、認証情報、秘密鍵
- `local-data`、SQLite本体と付随ファイル
- `backups`、private-data、localStorage退避ファイル
- ログ、キャッシュ、ビルド成果物

実在する園児、家庭、保護者、職員、パスワード、利用予定は登録しないでください。

## 確認コマンド

```powershell
npm test
npm run build
npm run lint
npx tsc --noEmit
```

認証、家庭アカウントによるログイン、画面からのSQLite利用、兄弟姉妹の提出、5分集計、Excel出力は第2段階以降で実装します。
