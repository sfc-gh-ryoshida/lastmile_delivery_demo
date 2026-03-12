import { NextResponse } from "next/server";
import { pgQuery } from "@/lib/postgres";

interface RawDriverStats {
  driver_id: string;
  driver_name: string;
  total_packages: number;
  delivered: number;
  absent: number;
  failed: number;
  in_transit: number;
  pending: number;
  progress_pct: number;
  speed: number;
  hours_elapsed: number;
  first_delivery: string | null;
  last_delivery: string | null;
  delivery_span_hours: number;
}

type Severity = "critical" | "warning" | "info";

interface AlertDef {
  ALERT_ID: string;
  DRIVER_ID: string;
  DRIVER_NAME: string;
  DATE: string;
  HOUR: number;
  ANOMALY_SCORE: number;
  EXPECTED_PACE: number;
  ACTUAL_PACE: number;
  SEVERITY: Severity;
  ALERT_TYPE: string;
  DESCRIPTION: string;
  RECOMMENDED_ACTION: string;
}

function classifyAlerts(rows: RawDriverStats[], date: string): AlertDef[] {
  const hour = new Date().getHours();
  const alerts: AlertDef[] = [];
  let idx = 0;

  const avgSpan = rows.reduce((s, r) => s + r.delivery_span_hours, 0) / Math.max(rows.length, 1);
  const avgPace = rows.reduce((s, r) => s + (r.delivery_span_hours > 0 ? r.delivered / r.delivery_span_hours : 0), 0) / Math.max(rows.length, 1);

  for (const r of rows) {
    const expectedPace = r.total_packages / 8;
    const actualPace = r.delivery_span_hours > 0 ? r.delivered / r.delivery_span_hours : 0;
    const paceRatio = expectedPace > 0 ? actualPace / expectedPace : 1;

    const makeAlert = (sev: Severity, type: string, score: number, desc: string, action: string) => {
      idx++;
      alerts.push({
        ALERT_ID: `ALT-${date}-${idx}`,
        DRIVER_ID: r.driver_id,
        DRIVER_NAME: r.driver_name,
        DATE: date,
        HOUR: hour,
        ANOMALY_SCORE: Math.round(score * 100) / 100,
        EXPECTED_PACE: Math.round(expectedPace * 10) / 10,
        ACTUAL_PACE: Math.round(actualPace * 10) / 10,
        SEVERITY: sev,
        ALERT_TYPE: type,
        DESCRIPTION: desc,
        RECOMMENDED_ACTION: action,
      });
    };

    if (r.progress_pct < 100 && r.progress_pct < 30 && r.hours_elapsed >= 4) {
      makeAlert(
        "critical", "配達遅延", Math.min(1, (1 - paceRatio) * 1.5),
        `${r.driver_name}の配達進捗が${r.progress_pct.toFixed(0)}%で大幅に遅延。${r.hours_elapsed.toFixed(0)}時間経過で${r.delivered}/${r.total_packages}件のみ完了。`,
        "近隣の余裕あるドライバーへ荷物を再割当てするか、応援ドライバーを手配してください。"
      );
    } else if (r.progress_pct < 100 && paceRatio < 0.5 && r.hours_elapsed >= 2) {
      makeAlert(
        "warning", "ペース低下", Math.min(1, (1 - paceRatio) * 1.2),
        `配達ペースが想定の${(paceRatio * 100).toFixed(0)}%に低下。想定${expectedPace.toFixed(1)}件/時に対し実績${actualPace.toFixed(1)}件/時。`,
        "渋滞・工事による遅延の可能性があります。ルート最適化を再実行するか、ドライバーに状況確認の連絡を入れてください。"
      );
    }

    if (r.absent > 3) {
      const absentRate = r.absent / Math.max(r.total_packages, 1);
      makeAlert(
        absentRate > 0.2 ? "critical" : "warning",
        "不在多発", Math.round(absentRate * 100) / 100,
        `不在件数が${r.absent}件（${(absentRate * 100).toFixed(0)}%）と異常に多い状態。エリアの在宅率が低い可能性があります。`,
        "配達時間帯をずらして再配達を計画するか、置き配・宅配ボックス利用を促すSMS通知を送信してください。"
      );
    }

    if (r.speed < 1 && r.in_transit > 0) {
      makeAlert(
        "warning", "停車検知", 0.7,
        `${r.driver_name}が配達中にもかかわらず長時間停車しています。車両トラブルまたは体調不良の可能性。`,
        "ドライバーに安否確認の連絡を入れてください。応答がない場合は現地確認を手配してください。"
      );
    }

    if (r.failed > 2) {
      makeAlert(
        "warning", "配達失敗", 0.5,
        `配達失敗が${r.failed}件発生。住所不備やアクセス困難な配達先が含まれている可能性。`,
        "失敗した配達先の住所を確認し、修正が必要な場合は顧客に連絡してください。"
      );
    }

    if (r.progress_pct >= 100 && r.speed < 1) {
      makeAlert(
        "info", "帰庫待ち", 0.3,
        `${r.driver_name}は全${r.total_packages}件の配達を完了し停車中。帰庫していない可能性があります。`,
        "帰庫状況を確認してください。日報提出を促し、翌日のルート準備に移行させてください。"
      );
    }

    if (r.delivery_span_hours > 0 && actualPace > avgPace * 1.5 && r.progress_pct >= 100) {
      makeAlert(
        "info", "高パフォーマンス", 0.2,
        `${r.driver_name}の配達ペースが${actualPace.toFixed(1)}件/時で全体平均${avgPace.toFixed(1)}件/時の${(actualPace / avgPace * 100).toFixed(0)}%。非常に効率的。`,
        "好事例としてチームに共有し、ルート設計やナビ活用のノウハウを収集してください。"
      );
    }

    if (r.delivery_span_hours > avgSpan * 1.3 && r.progress_pct >= 100) {
      makeAlert(
        "warning", "所要時間超過", Math.min(0.8, (r.delivery_span_hours / avgSpan - 1)),
        `全件完了まで${r.delivery_span_hours.toFixed(1)}時間を要し、平均${avgSpan.toFixed(1)}時間を${((r.delivery_span_hours / avgSpan - 1) * 100).toFixed(0)}%超過。`,
        "担当エリアの道路状況やルートを見直してください。荷物の割当て数の調整も検討してください。"
      );
    }
  }

  return alerts.sort((a, b) => {
    const sevOrder = { critical: 0, warning: 1, info: 2 };
    if (sevOrder[a.SEVERITY] !== sevOrder[b.SEVERITY]) return sevOrder[a.SEVERITY] - sevOrder[b.SEVERITY];
    return b.ANOMALY_SCORE - a.ANOMALY_SCORE;
  });
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const date = searchParams.get("date") || new Date().toISOString().split("T")[0];

  try {
    const rows = await pgQuery<RawDriverStats>(
      `SELECT
        d.driver_id,
        d.name AS driver_name,
        COUNT(ds.package_id)::int AS total_packages,
        COUNT(*) FILTER (WHERE ds.status = 'delivered')::int AS delivered,
        COUNT(*) FILTER (WHERE ds.status = 'absent')::int AS absent,
        COUNT(*) FILTER (WHERE ds.status = 'failed')::int AS failed,
        COUNT(*) FILTER (WHERE ds.status = 'in_transit')::int AS in_transit,
        COUNT(*) FILTER (WHERE ds.status = 'pending')::int AS pending,
        ROUND(
          COUNT(*) FILTER (WHERE ds.status = 'delivered')::numeric
          / NULLIF(COUNT(ds.package_id), 0) * 100, 1
        )::float AS progress_pct,
        COALESCE(dl.speed, 0)::float AS speed,
        GREATEST(EXTRACT(EPOCH FROM (NOW() - MIN(ds.completed_at))) / 3600.0, 0)::float AS hours_elapsed,
        MIN(ds.completed_at)::text AS first_delivery,
        MAX(ds.completed_at)::text AS last_delivery,
        COALESCE(
          EXTRACT(EPOCH FROM (MAX(ds.completed_at) - MIN(ds.completed_at))) / 3600.0,
          0
        )::float AS delivery_span_hours
      FROM drivers d
      LEFT JOIN delivery_status ds ON ds.driver_id = d.driver_id AND ds.date = $1
      LEFT JOIN driver_locations dl ON dl.driver_id = d.driver_id
      WHERE d.is_active = true
      GROUP BY d.driver_id, d.name, dl.speed
      HAVING COUNT(ds.package_id) > 0`,
      [date]
    );

    const alerts = classifyAlerts(rows, date);

    if (alerts.length > 0) {
      for (const a of alerts) {
        await pgQuery(
          `INSERT INTO delivery_alerts (alert_id, driver_id, date, hour, anomaly_score, severity, alert_type, description, recommended_action)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
           ON CONFLICT (alert_id) DO UPDATE SET anomaly_score = $5, severity = $6, description = $8`,
          [a.ALERT_ID, a.DRIVER_ID, a.DATE, a.HOUR, a.ANOMALY_SCORE, a.SEVERITY, a.ALERT_TYPE, a.DESCRIPTION, a.RECOMMENDED_ACTION]
        );
      }
    }

    return NextResponse.json(alerts);
  } catch (error) {
    console.error("Error fetching alerts:", error);
    return NextResponse.json([], { status: 200 });
  }
}
