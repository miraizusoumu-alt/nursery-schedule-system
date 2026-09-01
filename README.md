# 保護者向け利用予定提出システム 試作版

企業主導型保育園で、保護者が翌月の利用予定を提出し、園側が月ごとの予定を確認するための試作版です。現在は架空データだけを使用します。

## 必要な環境

- Node.js 22.23.2（`package.json`と`.node-version`で固定）
- npm
- Windows上のローカル確認を想定

## アプリの起動

```powershell
npm install
npm run dev
```

`npm run dev`は、SQLite認証を担当するNodeゲートウェイを`3000`番で起動し、既存Vinext画面を内部ポートへ転送します。PCでは `http://localhost:3000/` を開きます。画面の予定データは従来どおり`localStorage`を使用し、SQLiteへ自動移行しません。

通常利用者は必ず、起動時に表示される`http://localhost:3000/`または`http://PCのIPアドレス:3000/`を使用してください。背後のVinextは`127.0.0.1:3100`だけで待ち受け、起動時に生成する秘密情報を持つゲートウェイからの要求だけが保護画面を描画できます。内部ポートは確認用URLではありません。

## HTTPSリバースプロキシ配下での起動

production起動は `npm run build` 後の `npm start` を使用します。内部Vinextは引き続きloopbackだけで待ち受けます。
公開ポートは `NURSERY_PORT`、`PORT`、既定値の順で選択し、内部ポートとの同値や不正値はDBを開く前に拒否します。

| 環境変数 | 用途 | 必須／任意 |
|---|---|---|
| `NURSERY_DB_PATH` | 正式DBとは別の永続ストレージ上のステージングDB | 公開時必須 |
| `NURSERY_PORT` | 公開側待受ポート。`PORT`より優先 | 任意 |
| `PORT` | ホスティングから渡される公開側待受ポート | 任意 |
| `NURSERY_INTERNAL_PORT` | loopback上の内部Vinextポート | 任意 |
| `NURSERY_SECURE_COOKIES` | HTTPS公開時にSecure Cookieを強制 | HTTPS公開時必須 |
| `NURSERY_TRUST_PROXY` | 検証済みリバースプロキシのheader利用を明示的に有効化 | proxy公開時必須 |
| `NURSERY_TRUSTED_PROXY_CIDRS` | 信頼する接続元IPまたはCIDRのカンマ区切り一覧 | proxy信頼有効時必須 |
| `NURSERY_VERIFICATION_MODE` | ローカル検証DBを`.verification`内へ限定 | 任意 |

`NURSERY_TRUST_PROXY`は未設定／`false`なら転送headerを無視し、`true`でも実際のTCP接続元が許可一覧に一致した場合だけ利用します。
許可一覧は公開先で確認した最小範囲に限定し、全IPを信頼する設定は使用しません。内部Vinextを直接公開してはいけません。

信頼する入口proxyは、クライアント由来の `X-Forwarded-Proto` / `X-Forwarded-Host` を削除して、正しい公開protocol / hostを各1値で上書きする必要があります。
`http` / `https`以外、不正host、重複header、カンマ区切りのprotocol / host、片方だけの指定は400で拒否します。
複数proxyを経由する場合も入口から正規化済みの公開protocol / hostを渡してください。曖昧なchainを先頭値で推測しません。
`X-Forwarded-For`はproxyが実際の接続元を上書きまたは末尾追加することが前提です。IPのみを許可し、TCP接続元から右側の信頼済みproxyをたどり、最初の非信頼IPをログインrate limitへ使用します。
標準 `Forwarded` と `X-Real-IP` は採用せず、内部転送時にも削除します。未検証の任意headerを内部Vinextへ引き継ぎません。

公開先の接続元範囲・header上書き契約を確認できない場合は、proxy信頼を有効化せず公開を停止してください。
この設定はクラウドのアクセス制限や永続ディスク、バックアップ設定を代替しません。ローカル疎通は専用の一時DBだけで実施してください。

## 認証確認手順

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
- 保護者利用予定入力：`http://localhost:3000/parent/schedule`
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

## 第3段階の保護者利用予定入力

保護者ログイン後は、SQLiteに保存する`/parent/schedule`へ移動します。提出対象月は`submission_periods`で有効な1件だけを表示し、0件または複数件ある場合は月を独断で選ばず、園の管理者へ確認する案内を表示します。

この画面では、同じ家庭に紐づく園児だけを表示します。兄弟姉妹は画面上で切り替えて個別編集でき、「この子の予定を兄弟姉妹にも反映」で既存入力を確認後に上書きできます。一括反映後も園児ごとの個別修正ができます。提出は家庭単位で1回だけ行い、全園児分をDBトランザクションでまとめて更新します。

対象月の予定がまだ存在しない場合だけ、管理者が登録した園児ごとの`basic_usage_patterns`から初期予定を作成します。再表示時に保護者が修正した予定は上書きしません。休園日と日曜日は読み取り専用です。

入力途中の内容は自動的に下書き保存し、画面に「保存中」「保存済み」「保存失敗」を表示します。保存失敗時も入力内容は画面に残します。利用日は登園・降園時刻が必須で、時刻は`HH:mm`形式の5分単位、登園時刻は降園時刻より前である必要があります。画面とAPIの両方で検証します。期限判定は日本時間（Asia/Tokyo）基準です。期限超過または提出期間`closed`では、画面とAPIの両方で編集・保存・提出を禁止し、「変更が必要な場合は園へご連絡ください」と表示します。

家庭ごとの個別期限延長を保存するDB項目は現時点ではありません。第3段階ではマイグレーションを追加せず、全体の提出期限のみを使用します。

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

第3段階では保護者の月間予定入力・提出をSQLiteへ接続しています。5分集計、グラフ、Excel出力は第4段階以降で実装します。
