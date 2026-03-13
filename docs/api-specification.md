# Lastmile Delivery — API 仕様書

## 概要

Next.js App Router ベース。全 API は `/api/` 配下に配置。  
データアクセスは **pgQuery** (Snowflake Postgres OLTP) と **sfQuery** (Snowflake本体 分析/ML) のデュアルパス。

---

## ワークフロー全体フロー

```
[Plan 画面]
  driver-attendance → routes/generate → routes/assign → load-confirm
         ↓                                                    ↓
[Monitor 画面]
  locations / progress / alerts / traffic / dwell-time
         ↓                    ↓
  routes/readjust      routes/next-trip      driver-withdraw
         ↓                                        ↓
[Review 画面]
  daily-close → kpi / driver-performance / absence-heatmap / demand-forecast
```

---

## 1. Plan API

### 1.1 POST /api/plan/driver-attendance — ドライバー出退勤

**Request:**
```json
{
  "date": "2026-03-12",
  "updates": [
    { "driver_id": "DRV-001", "is_active": true },
    { "driver_id": "DRV-002", "is_active": false }
  ]
}
```

**DB 書込み:**
| テーブル | 操作 | 説明 |
|---------|------|------|
| drivers | UPDATE is_active | 稼働フラグ切替 |
| driver_attendance | UPSERT | status (present/absent) + check_in_time |

**Response:**
```json
{
  "date": "2026-03-12",
  "updated": 2,
  "failed": 0,
  "results": [{ "driver_id": "DRV-001", "is_active": true, "success": true }]
}
```

### 1.1b GET /api/plan/driver-attendance — ドライバー一覧

**Response:** `{ "drivers": [{ "driver_id", "name", "is_active", "depot_name" }] }`

---

### 1.2 POST /api/plan/routes/generate — ルート生成

Snowflake RISK_SCORES + ABSENCE_PATTERNS + H3_COST_MATRIX、および OSRM サイドカー (実道路距離・所要時間・ルート形状) を参照し最適ルートを計算。

**Request:**
```json
{
  "date": "2026-03-12",
  "mode": "auto",
  "confirm": false
}
```

| パラメータ | 型 | 必須 | デフォルト | 説明 |
|-----------|-----|------|----------|------|
| date | string | YES | | 配送日 (YYYY-MM-DD) |
| mode | string | NO | "auto" | 最適化モード |
| confirm | boolean | NO | false | true: DBに確定書込み、false: プレビューのみ |

**DB 書込み (confirm=true のみ):**
| テーブル | 操作 | 説明 |
|---------|------|------|
| routes | DELETE + INSERT | 対象日の既存ルート削除 → 全ドライバー×トリップ分を作成 |
| delivery_status | UPDATE | driver_id, trip_number, stop_order, status='assigned' |
| packages | UPDATE | route_id (`R-{driver}-{date}-T{trip}`), stop_order |

**データソース:** pgQuery (packages, drivers, construction) + sfQuery (RISK_SCORES, ABSENCE_PATTERNS, H3_COST_MATRIX) + OSRM (実道路距離行列・所要時間・ルート形状, `exclude=motorway`)

**Response:**
```json
{
  "date": "2026-03-12",
  "total_packages": 490,
  "assigned_packages": 485,
  "unassigned_packages": 5,
  "drivers_used": 12,
  "confirmed": true,
  "assignments": [
    {
      "driver_id": "DRV-001",
      "total_packages": 42,
      "trips": [
        {
          "trip": 1,
          "total_packages": 28,
          "departure_time": "08:30",
          "return_time": "12:15",
          "packages": [{ "package_id": "PKG-0312-0001", "stop_order": 1 }],
          "route": [{ "lat": 35.6466, "lng": 139.7828 }]
        }
      ]
    }
  ],
  "optimization_summary": {
    "cost_matrix_pairs": 1200,
    "risk_applied_count": 450,
    "osrm_enabled": true,
    "osrm_points": 502
  }
}
```

---

### 1.3 POST /api/plan/routes/assign — 手動割当て

**Request:**
```json
{
  "date": "2026-03-12",
  "moves": [
    {
      "package_id": "PKG-0312-0001",
      "from_driver_id": "DRV-001",
      "to_driver_id": "DRV-002",
      "trip_number": 1,
      "stop_order": 5
    }
  ]
}
```

**DB 書込み:**
| テーブル | 操作 | 説明 |
|---------|------|------|
| delivery_status | INSERT or UPDATE | driver_id, trip_number, stop_order, status='assigned' |
| packages | UPDATE | route_id, stop_order |
| routes | INSERT (ON CONFLICT DO NOTHING) | 対象ルートが未存在なら作成 |

**バリデーション:** status が `delivered` / `in_transit` の荷物は再割当て不可。

---

### 1.4 POST /api/plan/routes/load-confirm — 積み込み確認

**Request:**
```json
{
  "date": "2026-03-12",
  "driver_id": "DRV-001",
  "trip_number": 1
}
```

**DB 書込み:**
| テーブル | 操作 | 説明 |
|---------|------|------|
| delivery_status | UPDATE status='loaded' | assigned → loaded |
| packages | UPDATE loading_order | stop_order を loading_order にコピー |
| routes | UPDATE status='loaded' | planned/loading → loaded |

**Response:**
```json
{ "driver_id": "DRV-001", "date": "2026-03-12", "trip_number": 1, "loaded_count": 28 }
```

---

### 1.5 GET /api/plan/packages — 荷物一覧

**Query:** `?date=2026-03-12`  
**データソース:** pgQuery (packages + delivery_status LEFT JOIN)  
**DB 書込み:** なし (読み取り専用)

---

### 1.6 GET /api/plan/drivers — ドライバー一覧

**データソース:** pgQuery (drivers + depots JOIN)  
**DB 書込み:** なし

---

### 1.7 GET /api/plan/risk-map — リスクマップ

**Query:** `?date=2026-03-12&hour=10&source=sf`  
**データソース:** sfQuery (RISK_SCORES) or pgQuery (ft_risk_scores) ※source パラメータで切替  
**DB 書込み:** なし

---

### 1.8 GET /api/plan/building-density — 建物密度

**Query:** `?source=sf`  
**データソース:** sfQuery (BUILDING_ATTRIBUTES + DELIVERY_HISTORY) or pgQuery (ft_*)  
**DB 書込み:** なし

---

### 1.9 GET /api/plan/weather — 天気予報

**データソース:** sfQuery (V_WEATHER_FORECAST_LIVE)  
**DB 書込み:** なし

---

### 1.10 GET /api/plan/construction — 道路工事情報

**データソース:** pgQuery (road_construction)  
**DB 書込み:** なし

---

## 2. Monitor API

### 2.1 GET /api/monitor/locations — ドライバー位置

**Query:** `?date=2026-03-12`  
**データソース:** pgQuery (driver_locations + drivers + delivery_status)  
**DB 書込み:** なし

---

### 2.2 GET /api/monitor/progress — 配達進捗

**Query:** `?date=2026-03-12`  
**データソース:** pgQuery (delivery_status + drivers)  
**DB 書込み:** なし

---

### 2.3 GET /api/monitor/alerts — 配達アラート

**Query:** `?date=2026-03-12`

ドライバー統計からルールベースでアラートを分類し、DB に永続化。

**アラート種別:**
| alert_type | severity | トリガー条件 |
|-----------|----------|-------------|
| 配達遅延 | critical | 進捗<30% & 4時間経過 |
| ペース低下 | warning | ペースが想定の50%未満 & 2時間経過 |
| 不在多発 | critical/warning | 不在3件超 (>20%でcritical) |
| 停車検知 | warning | speed<1 & in_transit荷物あり |
| 配達失敗 | warning | failed 2件超 |
| 帰庫待ち | info | 全件完了 & 停車中 |
| 高パフォーマンス | info | ペースが平均の150%超 & 全件完了 |
| 所要時間超過 | warning | 完了時間が平均の130%超 |

**DB 書込み:**
| テーブル | 操作 | 説明 |
|---------|------|------|
| delivery_alerts | UPSERT (alert_id) | アラート永続化 (score/severity/description を更新) |

---

### 2.4 GET /api/monitor/routes — ルート一覧

**データソース:** pgQuery (routes + delivery_status + packages)  
**DB 書込み:** なし

---

### 2.5 GET /api/monitor/traffic — リアルタイム渋滞

**データソース:** pgQuery (traffic_realtime)  
**DB 書込み:** なし

---

### 2.6 GET /api/monitor/dwell-time — 滞在時間

**データソース:** pgQuery (delivery_dwell)  
**DB 書込み:** なし

---

### 2.7 GET /api/monitor/driver-trail — ドライバー軌跡

**データソース:** pgQuery (driver_locations_history)  
**DB 書込み:** なし

---

### 2.8 POST /api/monitor/routes/readjust — ルート再調整

リスクスコアを考慮して残配達の順序を再最適化。

**Request:**
```json
{
  "date": "2026-03-12",
  "driver_id": "DRV-001",
  "skip_absent": true,
  "confirm": false,
  "trip_number": 1
}
```

| パラメータ | 型 | 必須 | デフォルト | 説明 |
|-----------|-----|------|----------|------|
| date | string | YES | | |
| driver_id | string | YES | | |
| skip_absent | boolean | NO | true | 不在/高リスク停留所を後回しにする |
| confirm | boolean | NO | false | true: DB書込み |
| trip_number | number | NO | null | 特定トリップに絞る |

**DB 書込み (confirm=true):**
| テーブル | 操作 | 説明 |
|---------|------|------|
| delivery_status | UPDATE stop_order | 新しい配達順序 |
| packages | UPDATE stop_order | 同期 |
| routes | UPDATE total_distance, total_time_est, stop_count | ルート統計更新 |

**データソース:** pgQuery (delivery_status, packages, driver_locations) + sfQuery (RISK_SCORES)

---

### 2.9 POST /api/monitor/routes/next-trip — 次便生成

前便の未配達荷物 + 既存次便荷物をまとめて新トリップを計画。

**Request:**
```json
{
  "date": "2026-03-12",
  "driver_id": "DRV-001",
  "confirm": false
}
```

**DB 書込み (confirm=true):**
| テーブル | 操作 | 説明 |
|---------|------|------|
| routes | INSERT/UPSERT | 新トリップの routes レコード作成 |
| delivery_status | UPDATE | trip_number, stop_order, status='assigned' |
| packages | UPDATE | route_id, stop_order |

**データソース:** pgQuery (drivers, depots, delivery_status, packages) + sfQuery (RISK_SCORES, H3_COST_MATRIX)

**特記:** depot座標はDBから取得 (drivers JOIN depots)。

---

### 2.10 POST /api/monitor/driver-withdraw — ドライバー離脱

離脱ドライバーの未配達荷物を他ドライバーに最適再配分。

**Request:**
```json
{
  "date": "2026-03-12",
  "withdraw_driver_id": "DRV-003",
  "reason": "体調不良",
  "confirm": false
}
```

**DB 書込み (confirm=true):**
| テーブル | 操作 | 説明 |
|---------|------|------|
| delivery_status | UPDATE | 荷物を新ドライバーに再割当て (driver_id, trip_number, stop_order) |
| drivers | UPDATE is_active=false | 離脱ドライバー非活性化 |
| routes | UPDATE status='cancelled' | 離脱ドライバーの未完了ルートをキャンセル |
| driver_attendance | UPSERT | status='withdrawn', check_out_time, reason |

**再配分アルゴリズム:** 容量制約 (weight/volume/件数上限50) + 最近傍距離でドライバー選択。

---

### 2.11 POST /api/monitor/incident-sim — インシデントシミュレーション

**DB 書込み:** なし (シミュレーション結果のみ返却)

---

## 3. Review API

### 3.1 POST /api/review/daily-close — 日次締め

**Request:**
```json
{ "date": "2026-03-12" }
```

**DB 書込み:**
| テーブル | 操作 | 説明 |
|---------|------|------|
| delivery_status | UPDATE status='returned' | pending/assigned/loaded/in_transit/absent/failed → returned |
| routes | UPDATE status='completed' | 未完了ルートを全て完了に |
| driver_attendance | UPSERT check_out_time | 全ドライバーの退勤時刻記録 |

**Response:**
```json
{
  "date": "2026-03-12",
  "total_packages": 490,
  "delivered": 425,
  "returned": 40,
  "delivery_rate": 86.7,
  "status_breakdown": { "delivered": 425, "returned": 40, "absent": 25 },
  "by_driver": [{ "driver_id": "DRV-001", "name": "田中太郎", "delivered": 42, "returned": 3 }]
}
```

---

### 3.2 GET /api/review/kpi — KPI ダッシュボード

**Query:** `?date=2026-03-12`  
**データソース:** pgQuery (ft_kpi_daily, fallback: delivery_status から集計)  
**DB 書込み:** なし

---

### 3.3 GET /api/review/driver-performance — ドライバー実績

**データソース:** pgQuery (delivery_status + drivers)  
**DB 書込み:** なし

---

### 3.4 GET /api/review/absence-heatmap — 不在ヒートマップ

**データソース:** pgQuery (ft_absence_patterns)  
**DB 書込み:** なし

---

### 3.5 GET /api/review/demand-forecast — 需要予測

**データソース:** pgQuery (ft_demand_forecast)  
**DB 書込み:** なし

---

## 4. Admin API

### 4.1 POST /api/admin/demo-data — デモデータ生成

packages + delivery_status + routes を一括生成。

### 4.2 POST /api/admin/query — 汎用SQLクエリ

### 4.3 GET /api/admin/tables — テーブル一覧

### 4.4 GET /api/admin/snowflake-tables — Snowflakeテーブル一覧

### 4.5 POST /api/admin/snowflake-query — Snowflake汎用クエリ

### 4.6 POST /api/admin/sf-sync — Snowflake同期

### 4.7 GET /api/loading — ローディング状態

---

## 5. confirm パターン

複数のAPIで共通する `confirm` フラグパターン:

| confirm | 動作 |
|---------|------|
| false (デフォルト) | 計算結果をJSONで返却。DBは変更しない (プレビューモード) |
| true | 計算結果をDBに書込み後、JSONで返却 (確定モード) |

**対象API:** routes/generate, routes/readjust, routes/next-trip, driver-withdraw

---

## 6. データアクセスパス

| API | pgQuery (OLTP) | sfQuery (Snowflake) |
|-----|-----------------|---------------------|
| packages, drivers, construction, driver-attendance | YES | — |
| routes/assign, load-confirm | YES | — |
| routes/generate | YES | YES (RISK_SCORES, ABSENCE_PATTERNS, H3_COST_MATRIX) |
| risk-map | YES (ft_risk_scores, source=pg) | YES (RISK_SCORES, source=sf default) |
| building-density | YES (ft_*, source=pg) | YES (source=sf default) |
| weather | — | YES (V_WEATHER_FORECAST_LIVE) |
| locations, routes, alerts, progress, traffic, dwell-time, driver-trail | YES | — |
| routes/readjust | YES | YES (RISK_SCORES) |
| routes/next-trip | YES | YES (RISK_SCORES, H3_COST_MATRIX) |
| driver-withdraw, incident-sim | YES | — |
| kpi | YES (ft_kpi_daily) | — |
| absence-heatmap | YES (ft_absence_patterns) | — |
| demand-forecast | YES (ft_demand_forecast) | — |
| driver-performance, daily-close | YES | — |
