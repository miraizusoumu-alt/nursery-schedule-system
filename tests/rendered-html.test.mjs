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
  assert.match(html, /管理者ログイン/);
  assert.match(html, /管理者画面/);
  assert.doesNotMatch(html, /前月コピー|前月予定の確認|過去の提出内容一覧|過去月を選択/);
  assert.doesNotMatch(html, /Your site is taking shape|react-loading-skeleton|codex-preview/);
});

test("keeps the existing screens while domain and storage logic stay separated", async () => {
  const [page, css, layout, packageJson, types, schedule, placement, shift, prototype, storage] = await Promise.all([
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
  assert.match(worker, /GATEWAY_PROTECTED_PATHS/);
  assert.match(worker, /\/parent\/schedule/);
  assert.match(authHttp, /isParentSchedulePage/);
  assert.match(authHttp, /\/parent\/schedule/);
  assert.match(worker, /!env\.NURSERY_GATEWAY_SECRET \|\| receivedSecret !== env\.NURSERY_GATEWAY_SECRET/);
  assert.match(viteConfig, /NURSERY_GATEWAY_SECRET: process\.env\.NURSERY_GATEWAY_SECRET \?\? ""/);
  assert.match(readme, /内部ポートは確認用URLではありません/);
});

test("adds the protected database-backed parent schedule screen without changing the prototype top page", async () => {
  const [page, parentPage, parentClient, familyService, scheduleHttp, css] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/parent/schedule/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../components/parent/ParentScheduleClient.tsx", import.meta.url), "utf8"),
    readFile(new URL("../lib/server/family-schedule/service.mjs", import.meta.url), "utf8"),
    readFile(new URL("../server/family-schedule-http.mjs", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  ]);

  assert.match(page, /loadPrototypeStore/);
  assert.match(parentPage, /ParentScheduleClient/);
  assert.match(parentClient, /この子の予定を兄弟姉妹にも反映/);
  assert.match(parentClient, /保存中|保存済み|保存失敗/);
  assert.match(parentClient, /修正後は再提出が必要です/);
  assert.match(parentClient, /入力内容は画面に残しています/);
  assert.match(parentClient, /parent-fixed-actions|child-switcher/);
  assert.match(parentClient, /園から提出期限が延長されています/);
  assert.match(parentClient, /提出後、園で予定を変更しています/);
  assert.match(familyService, /CHILD_SCOPE_VIOLATION/);
  assert.match(familyService, /BEGIN IMMEDIATE/);
  assert.match(familyService, /Asia\/Tokyo|TOKYO_OFFSET_MINUTES/);
  assert.match(scheduleHttp, /assertCsrf/);
  assert.match(css, /parent-fixed-actions/);
  assert.match(css, /overflow-x:\s*hidden/);
  assert.match(css, /@media \(max-width:\s*719px\)/);
});

test("connects protected administrator schedule operations without changing the prototype", async () => {
  const [page, adminPage, adminClient, adminHttp, gateway, authHttp, worker, familyService] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/admin/schedules/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../components/admin/AdminScheduleClient.tsx", import.meta.url), "utf8"),
    readFile(new URL("../server/admin-schedule-http.mjs", import.meta.url), "utf8"),
    readFile(new URL("../server/gateway.mjs", import.meta.url), "utf8"),
    readFile(new URL("../server/auth-http.mjs", import.meta.url), "utf8"),
    readFile(new URL("../worker/index.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/server/family-schedule/service.mjs", import.meta.url), "utf8"),
  ]);

  assert.match(page, /loadPrototypeStore/);
  assert.match(adminPage, /AdminScheduleClient/);
  assert.match(adminClient, /保護者向け対象月|家庭別期限延長|最新提出内容の確認|保存前の確認|変更履歴/);
  assert.match(adminClient, /EFFECTIVE_VERSION_CHANGED|NO_CHANGES/);
  assert.match(adminHttp, /requireSession\(request, authService, \{ type: "administrator" \}\)/);
  assert.match(adminHttp, /assertCsrf/);
  assert.match(gateway, /handleAdminScheduleApiRequest/);
  assert.match(authHttp, /\/admin\/schedules/);
  assert.match(worker, /\/admin\/schedules/);
  assert.match(familyService, /administratorScheduleDashboard|administratorRevisionHistory/);
  assert.match(familyService, /changeSummary\?\.kind === "administrator_revision"/);
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
  assert.match(authClient, /requestAnimationFrame/);
  assert.match(authClient, /aria-pressed=\{visible\}/);
  assert.match(authClient, /コピーしました/);
  assert.match(authClient, /navigator\.clipboard\?\.writeText/);
  assert.match(css, /\.password-field-actions/);
  assert.match(css, /\.password-action/);
  assert.match(readme, /8文字以上・128文字以下/);
  assert.doesNotMatch(authClient, /12文字以上|minLength=\{12\}|min=\{12\}/);
});
