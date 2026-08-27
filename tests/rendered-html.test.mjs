import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

async function render() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);

  return worker.fetch(
    new Request("http://localhost/", {
      headers: { accept: "text/html" },
    }),
    {
      ASSETS: {
        fetch: async () => new Response("Not found", { status: 404 }),
      },
    },
    {
      waitUntil() {},
      passThroughOnException() {},
    },
  );
}

test("server-renders the parent, staff, and admin shell", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /<title>利用予定提出・職員シフト支援システム 試作版<\/title>/i);
  assert.match(html, /保護者向け利用予定提出/);
  assert.match(html, /保護者画面/);
  assert.match(html, /職員画面/);
  assert.match(html, /保護者ログイン/);
  assert.match(html, /正式な管理画面へ/);
  assert.match(html, /管理者画面/);
  assert.doesNotMatch(html, /前月コピー|前月予定の確認|過去の提出内容一覧|過去月を選択/);
  assert.doesNotMatch(html, /Your site is taking shape|react-loading-skeleton|codex-preview/);
});

test("keeps the existing screens while domain and storage logic stay separated", async () => {
  const [page, css, layout, packageJson, types, schedule, placement, shift, prototype, storage, staffManagement, adminClient] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
    readFile(new URL("../app/layout.tsx", import.meta.url), "utf8"),
    readFile(new URL("../package.json", import.meta.url), "utf8"),
    readFile(new URL("../lib/domain/types.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/domain/schedule.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/domain/placement.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/domain/shift.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/domain/prototype.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/storage/local-storage.ts", import.meta.url), "utf8"),
    readFile(new URL("../components/admin/AdminStaffManagement.tsx", import.meta.url), "utf8"),
    readFile(new URL("../components/admin/AdminScheduleClient.tsx", import.meta.url), "utf8"),
  ]);

  assert.match(page, /loadPrototypeStore/);
  assert.match(page, /savePrototypeStore/);
  assert.doesNotMatch(page, /function aggregateChildUsage|function calculateRequiredStaff|function generateShiftForMonth/);
  assert.doesNotMatch(page, /localStorage\.getItem|localStorage\.setItem/);

  assert.match(types, /type StaffProfile/);
  assert.match(types, /type LeavePeriod/);
  assert.match(types, /type LeaveRequest/);
  assert.match(types, /type PlacementRule/);
  assert.match(types, /type ShiftRecord/);
  assert.match(types, /type SystemHistoryEntry/);
  assert.match(types, /version:\s*3/);

  assert.match(storage, /nursery-schedule-prototype-v2/);
  assert.match(storage, /STORAGE_VERSION = 3/);
  assert.match(storage, /normalizeStore/);
  assert.match(storage, /loadPrototypeStore/);
  assert.match(storage, /savePrototypeStore/);

  assert.match(prototype, /permissions/);
  assert.match(page, /hasPermission\("staff", "staff:own-leave"\)/);
  assert.match(page, /hasPermission\("admin", "admin:leave-management"\)/);
  assert.match(schedule, /leaveKey\(staffId: string, monthKey: string, dateKey: string\)/);
  assert.match(page, /この日はすでに複数の職員が希望休を提出しています。/);
  assert.match(page, /targetShift\.status === "published"/);
  assert.match(shift, /staffAvailableForDate/);
  assert.match(shift, /staffHasLeave/);
  assert.match(shift, /overlaps/);
  assert.match(shift, /wouldExceedConsecutive/);
  assert.match(placement, /aggregateChildUsage/);
  assert.match(placement, /calculateRequiredStaff/);
  assert.match(shift, /generateShiftForMonth/);
  assert.match(shift, /assignment\.fixed/);
  assert.match(page, /勤務可能時間外のため、この勤務枠は追加できません。/);
  assert.match(page, /希望休の日には勤務を割り当てられません。/);
  assert.match(shift, /必要職員数が/);
  assert.match(shift, /有資格者が/);

  assert.match(page, /この内容で対象月の予定を作成する/);
  assert.match(page, /月間予定一覧/);
  assert.doesNotMatch(page, /copyPreviousMonth|previousPlans|previousStorageKey|previous-preview|前月コピー|前月予定の確認/);
  assert.doesNotMatch(page, /SkeletonPreview|codex-preview/);

  assert.match(css, /overflow-x:\s*hidden/);
  assert.match(css, /mobile-fixed-actions/);
  assert.match(css, /staff-dashboard/);
  assert.match(css, /staff-calendar-list/);
  assert.match(css, /admin-menu/);
  assert.match(css, /position:\s*sticky/);
  assert.match(css, /@media \(max-width:\s*719px\)/);
  assert.doesNotMatch(css, /previous-preview|previous-list/);

  assert.match(layout, /lang="ja"/);
  assert.match(layout, /職員希望休/);
  assert.match(page, /featureFlags\.workforcePrototype/);
  assert.match(page, /isWorkforceAdminMenu/);
  assert.match(page, /isWorkforceHistoryTarget/);
  assert.match(page, /試作機能・架空データのみ使用/);
  assert.doesNotMatch(page, /<option value="短時間">/);
  assert.doesNotMatch(types, /"短時間"/);
  assert.doesNotMatch(prototype, /employmentType:\s*"短時間"/);
  assert.match(staffManagement, /＋ 職員を登録/);
  assert.match(staffManagement, /勤務開始日/);
  assert.match(staffManagement, /担当区分を登録/);
  assert.match(staffManagement, /保育士.*園長.*マネージャー.*配膳.*その他/s);
  assert.match(staffManagement, /資格・研修/);
  assert.match(staffManagement, /保育士資格/);
  assert.match(staffManagement, /子育て支援員研修修了/);
  assert.match(staffManagement, /licensed_nursery_teacher/);
  assert.match(staffManagement, /childcare_support_worker_local_childcare/);
  assert.match(adminClient, /<AdminMonthlyHeadcount/);
  assert.match(staffManagement, /const checked = event\.currentTarget\.checked/);
  assert.doesNotMatch(staffManagement, /setResponsibilityTypes\(\(current\) => event\.currentTarget\.checked/);
  assert.match(staffManagement, /職員を選択してください/);
  assert.match(staffManagement, /6 \* 60 \+ 30/);
  assert.match(staffManagement, /index \* 15/);
  assert.match(staffManagement, /この曜日は勤務可能/);
  assert.match(staffManagement, /勤務可能時間候補/);
  assert.match(staffManagement, /勤務可能時間候補を追加/);
  assert.match(staffManagement, /祝日も勤務可能/);
  assert.match(staffManagement, /祝日の勤務：/);
  assert.match(staffManagement, /適用する週/);
  assert.match(staffManagement, /毎週/);
  assert.match(staffManagement, /指定した週だけ/);
  assert.match(staffManagement, /\[1, 2, 3, 4, 5\]\.map/);
  assert.match(staffManagement, /第\{ordinal\}/);
  assert.match(staffManagement, /value !== 0/);
  assert.match(staffManagement, /"06:45"/);
  assert.match(staffManagement, /"20:15"/);
  assert.match(staffManagement, /勤務条件を保存/);
  assert.match(staffManagement, /基本情報は未保存です。/);
  assert.match(staffManagement, /勤務条件の保存が完了しました。/);
  assert.match(staffManagement, /非常勤の契約勤務条件/);
  assert.match(staffManagement, /週勤務時間上限/);
  assert.match(staffManagement, /以内（ちょうどまで可）/);
  assert.match(staffManagement, /未満（ちょうどは不可）/);
  assert.match(staffManagement, /週希望最低勤務日数/);
  assert.match(staffManagement, /1日最低勤務時間/);
  assert.doesNotMatch(staffManagement, /月間勤務上限（時間）|連続勤務日数上限/);
  assert.doesNotMatch(staffManagement, /職員コード<\/span><input/);
  assert.ok(
    adminClient.indexOf("<AdminStaffManagement") < adminClient.indexOf("<AdminChildManagement"),
    "職員管理は /admin/schedules の先頭側へ表示する",
  );
  assert.match(packageJson, /"dev:host"/);
  assert.match(packageJson, /server\/run\.mjs/);
  assert.match(packageJson, /auth:dev-accounts/);
  assert.doesNotMatch(packageJson, /react-loading-skeleton/);

  await assert.rejects(access(new URL("../app/_sites-preview", import.meta.url)));
});

test("keeps protected pages behind the loopback-only authentication gateway", async () => {
  const [runner, gateway, worker, authHttp, viteConfig, readme] = await Promise.all([
    readFile(new URL("../server/run.mjs", import.meta.url), "utf8"),
    readFile(new URL("../server/gateway.mjs", import.meta.url), "utf8"),
    readFile(new URL("../worker/index.ts", import.meta.url), "utf8"),
    readFile(new URL("../server/auth-http.mjs", import.meta.url), "utf8"),
    readFile(new URL("../vite.config.ts", import.meta.url), "utf8"),
    readFile(new URL("../README.md", import.meta.url), "utf8"),
  ]);

  assert.match(runner, /--hostname", "127\.0\.0\.1"/);
  assert.match(runner, /randomBytes\(32\)/);
  assert.match(runner, /NURSERY_GATEWAY_SECRET/);
  assert.match(gateway, /headers\[GATEWAY_SECRET_HEADER\] = gatewaySecret/);
  assert.match(gateway, /key\.toLowerCase\(\) === GATEWAY_SECRET_HEADER/);
  assert.match(gateway, /socket\.on\("error", \(\) => upstream\.destroy\(\)\)/);
  assert.match(gateway, /upstream\.on\("error", \(\) => socket\.destroy\(\)\)/);
  assert.match(worker, /GATEWAY_PROTECTED_PATHS/);
  assert.match(worker, /\/parent\/schedule/);
  assert.match(authHttp, /isParentSchedulePage/);
  assert.match(authHttp, /\/parent\/schedule/);
  assert.match(worker, /!env\.NURSERY_GATEWAY_SECRET \|\| receivedSecret !== env\.NURSERY_GATEWAY_SECRET/);
  assert.match(viteConfig, /NURSERY_GATEWAY_SECRET: process\.env\.NURSERY_GATEWAY_SECRET \?\? ""/);
  assert.match(readme, /内部ポートは確認用URLではありません/);
});

test("adds the protected database-backed parent schedule screen without changing the prototype top page", async () => {
  const [page, parentPage, parentAccountPage, parentClient, authClient, familyService, scheduleHttp, css] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/parent/schedule/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/parent/account/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../components/parent/ParentScheduleClient.tsx", import.meta.url), "utf8"),
    readFile(new URL("../components/auth/AuthClient.tsx", import.meta.url), "utf8"),
    readFile(new URL("../lib/server/family-schedule/service.mjs", import.meta.url), "utf8"),
    readFile(new URL("../server/family-schedule-http.mjs", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  ]);

  assert.match(page, /loadPrototypeStore/);
  assert.match(parentPage, /ParentScheduleClient/);
  assert.match(parentPage, /翌月の利用予定/);
  assert.doesNotMatch(parentPage, /保護者向け正式画面/);
  assert.match(parentClient, /入力するお子さま/);
  assert.match(parentClient, /data\.children\.length > 1/);
  assert.match(parentClient, /入力内容は自動で保存されます/);
  assert.match(parentClient, /途中で画面を閉じても、入力した内容は残ります/);
  assert.match(parentClient, /保存しています|入力内容を保存しました|保存できませんでした/);
  assert.match(parentClient, /園から再提出が許可されています|再提出のため修正中/);
  assert.match(parentClient, /入力内容は画面に残しています/);
  assert.match(parentClient, /child-switcher/);
  assert.match(parentClient, /確認する月を選んでください/);
  assert.match(parentClient, /if \(periodId\) void loadDashboard\(periodId\)/);
  assert.doesNotMatch(parentClient, /かんたん入力|いつもの予定を反映する/);
  assert.match(parentClient, /曜日ごとに設定する/);
  assert.match(parentClient, /この予定をきょうだいにもコピー/);
  assert.match(parentClient, /コピー先で現在入力している内容は上書きされます/);
  assert.match(parentClient, /この内容で園へ提出する/);
  assert.match(parentClient, /この内容で園へ再提出する/);
  assert.match(parentClient, /この内容で園へ提出しますか？/);
  assert.match(parentClient, /提出後は、ご自身で予定を変更できません/);
  assert.match(parentClient, /戻って確認する/);
  assert.match(parentClient, /window\.scrollTo/);
  assert.match(parentClient, /parent-submission-complete/);
  assert.doesNotMatch(parentClient, /window\.confirm|\.confirm\(/);
  assert.doesNotMatch(parentClient, /parent-fixed-actions/);
  assert.doesNotMatch(parentClient, /<LogoutButton/);
  assert.doesNotMatch(parentClient, /href="\/parent\/account"/);
  assert.doesNotMatch(parentClient, /parent-account-menu|href="\/account\/password"/);
  assert.match(parentClient, /parent-footer-actions/);
  assert.match(parentClient, /\/api\/auth\/logout/);
  assert.doesNotMatch(parentClient, /提出・変更履歴|parent-history-list/);
  assert.doesNotMatch(parentClient, /parent-day-time/);
  assert.match(parentAccountPage, /ParentAccountView/);
  assert.match(authClient, /function LogoutButton|export function LogoutButton/);
  assert.match(authClient, /<LogoutButton \/>/);
  assert.match(parentClient, /ConfirmationDialog/);
  assert.match(parentClient, /role="dialog"/);
  assert.match(parentClient, /aria-modal="true"/);
  assert.match(parentClient, /提出後、園で予定を変更しています/);
  assert.match(parentClient, /コピー先で現在入力している内容は上書きされます/);
  assert.doesNotMatch(parentClient, /家庭内の入力状況|提出日時|最終更新日時/);
  assert.doesNotMatch(parentClient, /\b\d{1,3}(?:\.\d{1,3}){3}:\d+\b/);
  assert.doesNotMatch(parentClient, /提出期限|期限超過|期限延長/);
  assert.doesNotMatch(parentClient, /\{period\.status\}/);
  assert.match(familyService, /CHILD_SCOPE_VIOLATION/);
  assert.match(familyService, /BEGIN IMMEDIATE/);
  assert.match(familyService, /Asia\/Tokyo|TOKYO_OFFSET_MINUTES/);
  assert.match(scheduleHttp, /assertCsrf/);
  assert.match(scheduleHttp, /SUBMISSION_SCOPE_INVALID/);
  assert.match(css, /parent-quick-entry/);
  assert.match(css, /parent-submit-panel/);
  assert.match(css, /parent-dialog-backdrop/);
  assert.doesNotMatch(css, /\.parent-fixed-actions\s*\{/);
  assert.match(css, /overflow-x:\s*hidden/);
  assert.match(css, /@media \(max-width:\s*719px\)/);
});

test("connects protected administrator schedule operations without changing the prototype", async () => {
  const [page, adminPage, accountsPage, adminClient, adminNavigation, childManagement, staffSchedule, headcount, adminHttp, staffScheduleHttp, gateway, authHttp, worker, familyService, css] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/admin/schedules/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/admin/accounts/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../components/admin/AdminScheduleClient.tsx", import.meta.url), "utf8"),
    readFile(new URL("../components/admin/AdminNavigation.tsx", import.meta.url), "utf8"),
    readFile(new URL("../components/admin/AdminChildManagement.tsx", import.meta.url), "utf8"),
    readFile(new URL("../components/admin/AdminStaffScheduleManagement.tsx", import.meta.url), "utf8"),
    readFile(new URL("../components/admin/AdminMonthlyHeadcount.tsx", import.meta.url), "utf8"),
    readFile(new URL("../server/admin-schedule-http.mjs", import.meta.url), "utf8"),
    readFile(new URL("../server/staff-schedule-http.mjs", import.meta.url), "utf8"),
    readFile(new URL("../server/gateway.mjs", import.meta.url), "utf8"),
    readFile(new URL("../server/auth-http.mjs", import.meta.url), "utf8"),
    readFile(new URL("../worker/index.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/server/family-schedule/service.mjs", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  ]);

  assert.match(page, /loadPrototypeStore/);
  assert.match(adminPage, /AdminScheduleClient/);
  assert.match(adminPage, /正式な管理画面|園の運営管理/);
  assert.doesNotMatch(adminPage, /試作トップ/);
  assert.match(accountsPage, /園の運営管理/);
  assert.match(accountsPage, /AdminNavigation/);
  assert.doesNotMatch(accountsPage, /試作トップ/);
  assert.match(adminClient, /休園日・家庭保育協力日|最新提出内容の確認|保存前の確認|変更履歴|この家庭の再提出を許可/);
  assert.match(adminClient, /園児の利用予定|月間利用予定時間|予定を確認/);
  assert.doesNotMatch(adminClient, /確認する期間|新しい保護者向け対象月|\{family\.familyCode\}/);
  assert.match(adminClient, /AdminChildManagement/);
  assert.match(adminNavigation, /園児|利用予定|職員|シフト|集計・Excel|アカウント/);
  assert.doesNotMatch(adminClient, /管理トップ/);
  assert.doesNotMatch(adminNavigation, /管理トップ/);
  assert.doesNotMatch(adminClient, /提出期限を延長|延長後期限|提出版 第|現在採用中 第/);
  assert.doesNotMatch(adminClient, /\{period\.status\}/);
  assert.match(adminClient, /AdminStaffManagement/);
  assert.match(adminClient, /AdminStaffScheduleManagement/);
  assert.match(adminClient, /AdminMonthlyHeadcount/);
  assert.match(staffSchedule, /月間職員シフト|この月のシフトを作成|日別シフトを保存|シフトを確定|シフトを修正/);
  assert.match(staffSchedule, /選択日|月間|公休|連続勤務/);
  assert.match(staffSchedule, /自動シフトをプレビュー/);
  assert.match(staffSchedule, /この内容で下書きを作成/);
  assert.match(staffSchedule, /自動作成上の未解決事項はありません/);
  assert.match(staffSchedule, /保育従事者不足|保育士資格者不足|休憩未配置/);
  assert.match(staffSchedule, /現在の下書きを再チェック/);
  assert.match(staffSchedule, /未保存の変更があります。保存してから再チェックしてください/);
  assert.match(staffSchedule, /配置不足 \/ 保育従事者|勤務条件|現在の下書きに確認が必要な項目はありません/);
  assert.match(staffSchedule, /このシフトはまだ確定できません|確認事項があります|確定可能です/);
  assert.match(staffSchedule, /確認事項を確認してシフトを確定/);
  assert.match(staffSchedule, /未保存の変更があります。保存してから確定してください/);
  assert.match(staffScheduleHttp, /error\.details/);
  assert.match(staffSchedule, /acknowledgeWarnings/);
  assert.match(childManagement, /＋ 園児を新規登録|園児を選択してください|基本利用予定|基本利用パターン履歴/);
  assert.doesNotMatch(childManagement, /<span>変更理由<\/span>/);
  assert.match(childManagement, /保護者ログインアカウント未作成/);
  assert.match(childManagement, /保護者ログインアカウントを発行|既存の保護者ログインアカウントに追加/);
  assert.doesNotMatch(childManagement, /membership\.familyName/);
  assert.match(adminClient, /admin-closure-calendar/);
  assert.match(adminClient, /monthCalendar\(selectedTargetMonth\)/);
  assert.match(adminClient, /対象年度・対象月|monthsForFiscalYear|\{year\}年度|家庭保育協力日/);
  assert.match(familyService, /isHardClosure|parent_input_allowed|family_cooperation/);
  assert.doesNotMatch(childManagement, /<span>クラス<\/span>/);
  assert.match(childManagement, /姓（かな）|名（かな）/);
  assert.doesNotMatch(childManagement, /家庭所属の開始日|家庭所属の終了日/);
  assert.match(childManagement, /基本利用予定を保存/);
  assert.match(headcount, /0歳児.*1歳児.*2歳児.*合計/s);
  assert.match(headcount, /年齢別の園児人数または必要人数が変わる時刻だけ/);
  assert.match(headcount, /必要保育従事者/);
  assert.match(headcount, /うち保育士資格者/);
  assert.match(adminClient, /EFFECTIVE_VERSION_CHANGED|NO_CHANGES/);
  assert.match(adminHttp, /requireSession\(request, authService, \{ type: "administrator" \}\)/);
  assert.match(adminHttp, /assertCsrf/);
  assert.match(staffScheduleHttp, /requireSession\(request, authService, \{ type: "administrator" \}\)/);
  assert.match(staffScheduleHttp, /assertCsrf/);
  assert.match(staffScheduleHttp, /\/api\/admin\/staff-schedules\/automatic-preview/);
  assert.match(staffScheduleHttp, /\/api\/admin\/staff-schedules\/automatic-draft/);
  assert.match(staffScheduleHttp, /\/api\/admin\/staff-schedules\/draft-review/);
  assert.match(gateway, /handleAdminScheduleApiRequest/);
  assert.match(gateway, /handleStaffScheduleApiRequest/);
  assert.match(gateway, /administratorQuarterHourStaffingRequirements/);
  assert.match(authHttp, /\/admin\/schedules/);
  assert.match(worker, /\/admin\/schedules/);
  assert.match(familyService, /administratorScheduleDashboard|administratorRevisionHistory/);
  assert.match(familyService, /changeSummary\?\.kind === "administrator_revision"/);
  assert.match(familyService, /administratorQuarterHourStaffingRequirements/);
  assert.match(css, /"Yu Gothic UI"/);
  assert.match(css, /grid-template-columns:\s*repeat\(6/);
  assert.match(css, /admin-nav-logout/);
  assert.match(css, /automatic-shift-preview/);
  assert.match(css, /automatic-preview-days/);
});

test("supports password managers, visibility controls, and the eight-character policy", async () => {
  const [authClient, security, css, readme] = await Promise.all([
    readFile(new URL("../components/auth/AuthClient.tsx", import.meta.url), "utf8"),
    readFile(new URL("../lib/server/auth/security.mjs", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
    readFile(new URL("../README.md", import.meta.url), "utf8"),
  ]);

  assert.match(security, /PASSWORD_MIN_LENGTH = 8/);
  assert.match(authClient, /minLength=\{8\}/);
  assert.match(authClient, /maxLength=\{128\}/);
  assert.match(authClient, /name="currentPassword"/);
  assert.match(authClient, /name="newPassword"/);
  assert.match(authClient, /name="newPasswordConfirmation"/);
  assert.match(authClient, /autoComplete="current-password"/);
  assert.match(authClient, /autoComplete="new-password"/);
  assert.match(authClient, /new FormData\(event\.currentTarget\)/);
  assert.match(authClient, /defaultValue=\{value\}/);
  assert.match(authClient, /onInput=/);
  assert.doesNotMatch(authClient, /\n\s+value=\{value\}\n/);
  assert.match(authClient, /requestAnimationFrame/);
  assert.match(authClient, /aria-pressed=\{visible\}/);
  assert.match(authClient, /コピーしました/);
  assert.match(authClient, /保護者用 利用予定表ログイン案内/);
  assert.match(authClient, /navigator\.clipboard\?\.writeText/);
  assert.match(authClient, /保護者ログインアカウント：作成済み/);
  assert.match(authClient, /ログイン情報を確認/);
  assert.match(authClient, /ログイン情報を閉じる/);
  assert.match(authClient, /copyPasswordToClipboard\(family\.login_id\)/);
  assert.match(authClient, /パスワードは表示できません。必要な場合は再発行してください。/);
  assert.doesNotMatch(authClient, /<th>ログインID<\/th>/);
  assert.match(authClient, /type="button" onClick=\{\(event\) => event\.currentTarget\.form\?\.requestSubmit\(\)\}/);
  assert.match(authClient, /event\.preventDefault\(\)/);
  assert.match(authClient, /ログインIDまたはパスワードが正しくありません。/);
  assert.match(authClient, /通信に失敗しました。しばらくしてからもう一度お試しください。/);
  assert.match(authClient, /ログイン処理でエラーが発生しました。しばらくしてからもう一度お試しください。/);
  assert.match(authClient, /formData\.get\("username"\)/);
  assert.match(authClient, /passwordInputRef\.current\.value = ""/);
  assert.match(authClient, /loginIdInputRef\.current\.value = submittedLoginId/);
  assert.doesNotMatch(authClient, /setLoginId\(/);
  assert.doesNotMatch(authClient, /value=\{loginId\}/);
  assert.match(css, /\.password-field-actions/);
  assert.match(css, /\.password-action/);
  assert.match(readme, /8文字以上・128文字以下/);
  assert.doesNotMatch(authClient, /12文字以上|minLength=\{12\}|min=\{12\}/);
});
