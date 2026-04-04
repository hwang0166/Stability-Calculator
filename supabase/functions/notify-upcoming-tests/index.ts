// notify-upcoming-tests — Supabase Edge Function (Deno)
// 매일 cron으로 호출되어 D-N일 이내 시험 예정 항목을 이메일로 발송
// 발송: Gmail SMTP via nodemailer (npm:nodemailer)

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import nodemailer from "npm:nodemailer@6";

// ── 환경변수 ──────────────────────────────────────────────────────────
const SUPABASE_URL           = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_KEY   = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const GMAIL_USER             = Deno.env.get("GMAIL_USER")!;
const GMAIL_APP_PASSWORD     = Deno.env.get("GMAIL_APP_PASSWORD")!;
const LEADER_EMAIL           = Deno.env.get("LEADER_EMAIL") ?? "";
const NOTIFY_SECRET          = Deno.env.get("NOTIFY_SECRET") ?? "";

// ── KST 날짜 유틸 (HTML 쪽 parseLocalDate / formatLocalDate 동일 로직) ─
function parseLocalDate(str: string): Date {
  const [y, m, d] = str.split("-").map(Number);
  return new Date(y, m - 1, d);
}
function formatLocalDate(date: Date): string {
  const y  = date.getFullYear();
  const m  = String(date.getMonth() + 1).padStart(2, "0");
  const d  = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}
function todayKST(): Date {
  // UTC+9 로컬 날짜를 자정으로 반환
  const now = new Date();
  const kst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  return new Date(kst.getUTCFullYear(), kst.getUTCMonth(), kst.getUTCDate());
}

// ── getAnalysis (HTML 쪽 동일 로직) ─────────────────────────────────
type DeviationEntry = { date: string; days: number; reason?: string };
type CompletedPoint = { point: number; actual_date: string; tester?: string };

interface StabilityTest {
  id: string;
  test_no: string;
  product_name: string;
  batch_no: string;
  chamber_no?: string;
  start_date: string;
  unit: "month" | "week";
  intervals: string;
  assignee: string;
  deviation_history?: DeviationEntry[];
  completed_points?: CompletedPoint[];
}

function getAnalysis(item: StabilityTest, v: number) {
  const start = parseLocalDate(item.start_date);

  let expected = new Date(start);
  if (item.unit === "month") {
    expected.setMonth(expected.getMonth() + v);
  } else {
    expected.setDate(expected.getDate() + v * 7);
  }
  if (v !== 0) expected.setDate(expected.getDate() - 1);
  const original = formatLocalDate(expected);

  const devHistory: DeviationEntry[] = Array.isArray(item.deviation_history)
    ? [...item.deviation_history]
    : [];
  // start_date 이후만 필터 & 날짜순 정렬
  const filtered = devHistory
    .filter((d) => parseLocalDate(d.date) >= start)
    .sort((a, b) => parseLocalDate(a.date).getTime() - parseLocalDate(b.date).getTime());

  let finalDate = new Date(expected);
  let totalDelay = 0;
  for (const dev of filtered) {
    finalDate.setDate(finalDate.getDate() + Number(dev.days));
    totalDelay += Number(dev.days);
  }
  return {
    original,
    final: formatLocalDate(finalDate),
    delay: totalDelay,
  };
}

// ── 알림 대상 시점 수집 ──────────────────────────────────────────────
function getAlertTimepoints(
  item: StabilityTest,
  daysBefore: number[],
  today: Date
): Array<{ v: number; label: string; finalDate: string; dday: number }> {
  const intervals = item.intervals
    .split(",")
    .map((s) => Number(s.trim()))
    .filter((n) => !isNaN(n));

  const completedSet = new Set(
    (item.completed_points ?? []).map((cp) => cp.point)
  );

  const results = [];
  for (const v of intervals) {
    if (completedSet.has(v)) continue;
    const { final } = getAnalysis(item, v);
    const finalDate = parseLocalDate(final);
    const diffMs = finalDate.getTime() - today.getTime();
    const dday = Math.round(diffMs / (1000 * 60 * 60 * 24));

    // daysBefore 배열의 값과 정확히 일치하는 경우만 알림
    if (daysBefore.includes(dday)) {
      const label = item.unit === "month" ? `${v}M` : `${v}W`;
      results.push({ v, label, finalDate: final, dday });
    }
  }
  return results;
}

// ── HTML 이메일 템플릿 ────────────────────────────────────────────────
function buildAssigneeEmail(
  assigneeName: string,
  rows: Array<{ item: StabilityTest; label: string; finalDate: string; dday: number }>
): string {
  const rowsHtml = rows
    .map(
      ({ item, label, finalDate, dday }) => `
      <tr>
        <td style="padding:8px 12px;border-bottom:1px solid #e2e8f0;">${item.test_no}</td>
        <td style="padding:8px 12px;border-bottom:1px solid #e2e8f0;">${item.product_name}</td>
        <td style="padding:8px 12px;border-bottom:1px solid #e2e8f0;">${item.batch_no}</td>
        <td style="padding:8px 12px;border-bottom:1px solid #e2e8f0;text-align:center;">${label}</td>
        <td style="padding:8px 12px;border-bottom:1px solid #e2e8f0;text-align:center;">${finalDate}</td>
        <td style="padding:8px 12px;border-bottom:1px solid #e2e8f0;text-align:center;font-weight:bold;color:${dday <= 3 ? "#dc2626" : "#d97706"};">
          D-${dday}
        </td>
      </tr>`
    )
    .join("");

  return `<!DOCTYPE html>
<html lang="ko">
<head><meta charset="UTF-8"></head>
<body style="font-family:'맑은 고딕',Arial,sans-serif;background:#f8fafc;margin:0;padding:24px;">
  <div style="max-width:700px;margin:0 auto;background:white;border-radius:12px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.1);">
    <div style="background:linear-gradient(135deg,#1e3a5f,#2563eb);padding:24px 32px;color:white;">
      <h2 style="margin:0;font-size:20px;">안정성 시험 일정 알림</h2>
      <p style="margin:6px 0 0;opacity:0.85;font-size:14px;">다가오는 시험 예정일 안내</p>
    </div>
    <div style="padding:24px 32px;">
      <p style="color:#374151;">안녕하세요, <strong>${assigneeName}</strong>님.<br>
      담당하신 안정성 시험 시점이 가까워지고 있습니다. 아래 일정을 확인해 주세요.</p>

      <table style="width:100%;border-collapse:collapse;margin-top:16px;font-size:14px;">
        <thead>
          <tr style="background:#f1f5f9;">
            <th style="padding:10px 12px;text-align:left;border-bottom:2px solid #e2e8f0;color:#64748b;font-weight:600;">시험번호</th>
            <th style="padding:10px 12px;text-align:left;border-bottom:2px solid #e2e8f0;color:#64748b;font-weight:600;">품목명</th>
            <th style="padding:10px 12px;text-align:left;border-bottom:2px solid #e2e8f0;color:#64748b;font-weight:600;">배치번호</th>
            <th style="padding:10px 12px;text-align:center;border-bottom:2px solid #e2e8f0;color:#64748b;font-weight:600;">시점</th>
            <th style="padding:10px 12px;text-align:center;border-bottom:2px solid #e2e8f0;color:#64748b;font-weight:600;">예정일</th>
            <th style="padding:10px 12px;text-align:center;border-bottom:2px solid #e2e8f0;color:#64748b;font-weight:600;">D-day</th>
          </tr>
        </thead>
        <tbody>${rowsHtml}</tbody>
      </table>

      <p style="margin-top:24px;color:#6b7280;font-size:13px;">
        본 메일은 안정성 시험 관리 시스템에서 자동 발송되었습니다.
      </p>
    </div>
  </div>
</body>
</html>`;
}

function buildLeaderEmail(
  allRows: Array<{ item: StabilityTest; label: string; finalDate: string; dday: number }>,
  today: Date
): string {
  // 담당자별 그룹핑
  const byAssignee = new Map<string, typeof allRows>();
  for (const row of allRows) {
    const name = row.item.assignee || "미지정";
    if (!byAssignee.has(name)) byAssignee.set(name, []);
    byAssignee.get(name)!.push(row);
  }

  const summaryHtml = Array.from(byAssignee.entries())
    .map(
      ([name, rows]) =>
        `<tr>
          <td style="padding:8px 12px;border-bottom:1px solid #e2e8f0;">${name}</td>
          <td style="padding:8px 12px;border-bottom:1px solid #e2e8f0;text-align:center;">${rows.length}건</td>
          <td style="padding:8px 12px;border-bottom:1px solid #e2e8f0;font-size:12px;color:#6b7280;">
            ${rows.map((r) => `${r.item.test_no} ${r.label} (D-${r.dday})`).join(", ")}
          </td>
        </tr>`
    )
    .join("");

  const totalRows = allRows
    .map(
      ({ item, label, finalDate, dday }) => `
      <tr>
        <td style="padding:7px 10px;border-bottom:1px solid #e2e8f0;font-size:13px;">${item.test_no}</td>
        <td style="padding:7px 10px;border-bottom:1px solid #e2e8f0;font-size:13px;">${item.product_name}</td>
        <td style="padding:7px 10px;border-bottom:1px solid #e2e8f0;font-size:13px;">${item.batch_no}</td>
        <td style="padding:7px 10px;border-bottom:1px solid #e2e8f0;font-size:13px;text-align:center;">${label}</td>
        <td style="padding:7px 10px;border-bottom:1px solid #e2e8f0;font-size:13px;text-align:center;">${finalDate}</td>
        <td style="padding:7px 10px;border-bottom:1px solid #e2e8f0;font-size:13px;text-align:center;color:#64748b;">${item.assignee || "-"}</td>
        <td style="padding:7px 10px;border-bottom:1px solid #e2e8f0;font-size:13px;text-align:center;font-weight:bold;color:${dday <= 3 ? "#dc2626" : "#d97706"};">D-${dday}</td>
      </tr>`
    )
    .join("");

  const todayStr = formatLocalDate(today);

  return `<!DOCTYPE html>
<html lang="ko">
<head><meta charset="UTF-8"></head>
<body style="font-family:'맑은 고딕',Arial,sans-serif;background:#f8fafc;margin:0;padding:24px;">
  <div style="max-width:750px;margin:0 auto;background:white;border-radius:12px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.1);">
    <div style="background:linear-gradient(135deg,#1e3a5f,#2563eb);padding:24px 32px;color:white;">
      <h2 style="margin:0;font-size:20px;">안정성 시험 알림 요약 — ${todayStr}</h2>
      <p style="margin:6px 0 0;opacity:0.85;font-size:14px;">전체 ${allRows.length}건 해당</p>
    </div>
    <div style="padding:24px 32px;">

      <h3 style="color:#1e293b;font-size:15px;margin-bottom:12px;">담당자별 요약</h3>
      <table style="width:100%;border-collapse:collapse;font-size:14px;margin-bottom:28px;">
        <thead>
          <tr style="background:#f1f5f9;">
            <th style="padding:9px 12px;text-align:left;border-bottom:2px solid #e2e8f0;color:#64748b;">담당자</th>
            <th style="padding:9px 12px;text-align:center;border-bottom:2px solid #e2e8f0;color:#64748b;">건수</th>
            <th style="padding:9px 12px;text-align:left;border-bottom:2px solid #e2e8f0;color:#64748b;">항목</th>
          </tr>
        </thead>
        <tbody>${summaryHtml}</tbody>
      </table>

      <h3 style="color:#1e293b;font-size:15px;margin-bottom:12px;">전체 목록</h3>
      <table style="width:100%;border-collapse:collapse;font-size:13px;">
        <thead>
          <tr style="background:#f1f5f9;">
            <th style="padding:8px 10px;text-align:left;border-bottom:2px solid #e2e8f0;color:#64748b;">시험번호</th>
            <th style="padding:8px 10px;text-align:left;border-bottom:2px solid #e2e8f0;color:#64748b;">품목명</th>
            <th style="padding:8px 10px;text-align:left;border-bottom:2px solid #e2e8f0;color:#64748b;">배치번호</th>
            <th style="padding:8px 10px;text-align:center;border-bottom:2px solid #e2e8f0;color:#64748b;">시점</th>
            <th style="padding:8px 10px;text-align:center;border-bottom:2px solid #e2e8f0;color:#64748b;">예정일</th>
            <th style="padding:8px 10px;text-align:center;border-bottom:2px solid #e2e8f0;color:#64748b;">담당자</th>
            <th style="padding:8px 10px;text-align:center;border-bottom:2px solid #e2e8f0;color:#64748b;">D-day</th>
          </tr>
        </thead>
        <tbody>${totalRows}</tbody>
      </table>

      <p style="margin-top:24px;color:#6b7280;font-size:13px;">
        본 메일은 안정성 시험 관리 시스템에서 자동 발송되었습니다.
      </p>
    </div>
  </div>
</body>
</html>`;
}

// ── CORS 헤더 ────────────────────────────────────────────────────────
const CORS_HEADERS = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

// ── 메인 핸들러 ──────────────────────────────────────────────────────
Deno.serve(async (req: Request) => {
  // Preflight
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  try {
    // 시크릿 인증: ?secret=XXX 또는 Authorization: Bearer XXX
    if (NOTIFY_SECRET) {
      const url      = new URL(req.url);
      const qs       = url.searchParams.get("secret") ?? "";
      const bearer   = (req.headers.get("Authorization") ?? "").replace("Bearer ", "");
      if (qs !== NOTIFY_SECRET && bearer !== NOTIFY_SECRET) {
        return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: CORS_HEADERS });
      }
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

    // 1. 알림 설정 조회
    const { data: settings } = await supabase
      .from("notification_settings")
      .select("*")
      .limit(1)
      .single();

    if (!settings || !settings.enabled) {
      return new Response(JSON.stringify({ message: "알림 비활성화 상태" }), { status: 200, headers: CORS_HEADERS });
    }

    const daysBefore: number[] = settings.days_before ?? [7, 3];
    const leaderEmail: string  = settings.leader_email ?? LEADER_EMAIL;

    // 2. 전체 배치 조회
    const { data: tests, error: testsErr } = await supabase
      .from("stability_tests")
      .select("*");
    if (testsErr) throw testsErr;

    // 3. 담당자 프로필 (이메일) 조회
    const { data: profiles } = await supabase
      .from("profiles")
      .select("name, email");
    const emailByName = new Map<string, string>(
      (profiles ?? []).filter((p: { name: string; email: string | null }) => p.email)
        .map((p: { name: string; email: string }) => [p.name, p.email])
    );

    // 4. 오늘 KST 기준 알림 대상 수집
    const today = todayKST();
    const allRows: Array<{ item: StabilityTest; label: string; finalDate: string; dday: number }> = [];

    for (const item of tests ?? []) {
      const hits = getAlertTimepoints(item as StabilityTest, daysBefore, today);
      for (const hit of hits) {
        allRows.push({ item: item as StabilityTest, label: hit.label, finalDate: hit.finalDate, dday: hit.dday });
      }
    }

    if (allRows.length === 0) {
      return new Response(JSON.stringify({ message: "알림 대상 없음", date: formatLocalDate(today) }), { status: 200, headers: CORS_HEADERS });
    }

    // 5. nodemailer Gmail SMTP 클라이언트
    const transporter = nodemailer.createTransport({
      host: "smtp.gmail.com",
      port: 465,
      secure: true,
      auth: { user: GMAIL_USER, pass: GMAIL_APP_PASSWORD },
    });

    async function sendEmail(to: string, subject: string, html: string): Promise<void> {
      await transporter.sendMail({
        from: `"안정성 시험 알림" <${GMAIL_USER}>`,
        to,
        subject,
        html,
      });
    }

    const sent: string[] = [];
    const skipped: string[] = [];

    // 6. 담당자별 이메일 발송
    const byAssignee = new Map<string, typeof allRows>();
    for (const row of allRows) {
      const name = row.item.assignee || "";
      if (!byAssignee.has(name)) byAssignee.set(name, []);
      byAssignee.get(name)!.push(row);
    }

    for (const [assigneeName, rows] of byAssignee.entries()) {
      const toEmail = emailByName.get(assigneeName);
      if (!toEmail) {
        skipped.push(assigneeName || "미지정");
        continue;
      }
      const minDday = Math.min(...rows.map((r) => r.dday));
      const subject = `[안정성 시험] D-${minDday} 알림 — 담당 시험 ${rows.length}건`;
      const html = buildAssigneeEmail(assigneeName, rows);

      await sendEmail(toEmail, subject, html);
      sent.push(`${assigneeName} <${toEmail}>`);
    }

    // 7. 리더 요약 이메일
    if (leaderEmail) {
      const subject = `[안정성 시험] ${formatLocalDate(today)} 알림 요약 — ${allRows.length}건`;
      const html = buildLeaderEmail(allRows, today);
      await sendEmail(leaderEmail, subject, html);
      sent.push(`리더 <${leaderEmail}>`);
    }

    return new Response(
      JSON.stringify({ success: true, date: formatLocalDate(today), sent, skipped, total: allRows.length }),
      { status: 200, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } }
    );
  } catch (err) {
    console.error(err);
    return new Response(JSON.stringify({ error: String(err) }), { status: 500, headers: CORS_HEADERS });
  }
});
