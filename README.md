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

`npm run dev`は、SQLite認証を担当するNodeゲートウェイを`3000`番で起動し、既存Vinext画面を内部ポートへ転送します。PCでは `http://localhost:3000/` を開きます。画面の予定データは従来どおり`localStorage`を使用し、SQLiteへ自動移行しません。

通常利用者は必ず、起動時に表示される`http://localhost:3000/`または`http://PCのIPアドレス:3000/`を使用してください。背後のVinextは`127.0.0.1:3100`だけで待ち受け、起動時に生成する秘密情報を持つゲートウェイからの要求だけが保護画面を描画できます。内部ポートは確認用URLではありません。

## 第2段階の認証確認

最初に、架空の開発用アカウントを作成します。

```powershell
npm run auth:dev-accounts
```

架空家庭、架空通常管理者、架空マスター管理者のログインIDと初期パスワードが、その実行時に一度だけ表示されます。同じコマンドを再実行してもアカウントやパスワードは増えず、作成済みパスワードも表示されません。

明示的に開発用パスワードを再発行し、既存セッションをすべて無効にする場合だけ次を使用します。

```powershell
npm run auth:dev-reset
```

確認URLは次のとおりです。

- 保護者ログイン：`http://localhost:3000/auth/parent`
- 管理者ログイン：`http://localhost:3000/auth/admin`
- 初回・仮パスワード変更：ログイン後に自動表示
- 家庭アカウント画面：`http://localhost:3000/parent/account`
- 管理者アカウント管理：`http://localhost:3000/admin/accounts`

Cookieは`HttpOnly`、`SameSite=Lax`、`Path=/`で発行されます。HTTPSで本番相当の確認を行う場合は、PowerShellで`$env:NURSERY_SECURE_COOKIES = "true"`を設定してから起動すると`Secure`も有効になります。通常の`http://localhost`確認では設定しないでください。

新しいパスワードは、保護者・通常管理者・マスター管理者ともに8文字以上・128文字以下です。英字・数字・記号を使用でき、文字種類の組み合わせは強制しません。既存パスワードはこの変更によって無効になりません。

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

職員希望休・シフト支援は、通常の役割切替と管理者メニューから開ける試作機能です。「試作機能・架空データのみ使用」と表示し、既存コードと`localStorage`データをそのまま使用します。第2段階の認証SQLiteや保護APIには接続・移行していません。

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

第2段階では認証・権限と最小限のアカウント管理だけをSQLiteへ接続しています。月間予定のDB保存、兄弟姉妹の予定入力、5分集計、グラフ、Excel出力は第3段階以降で実装します。
