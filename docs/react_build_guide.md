# ラストワンマイル配送所長アプリ — React 構築手順書

## 概要

本手順書は企画書 (`logistics_demo_proposal.md`) の Phase 7 に相当する React アプリケーション構築の詳細手順を定義する。

**アプリ種別:** 配送所長向け業務アプリ（計画・実行・振り返りの 3 タブ構成）
**デプロイ先:** ローカル開発 → SPCS (Snowpark Container Services)
**データソース:**
- **Snowflake 本体 (LASTMILE_DB)**: ANALYTICS スキーマ 8 テーブル + ML モデル
- **Snowflake Postgres (lastmile_postgres)**: OLTP 8 テーブル

---

## 1. 技術スタック

| カテゴリ | 技術 | 用途 |
|---------|------|------|
| フレームワーク | Next.js 15 (App Router) + TypeScript | SSR + API Routes |
| UI | shadcn/ui + Tailwind CSS | コンポーネント |
| 地図 | deck.gl + Mapbox GL JS | H3 ヘキサゴン、ルート表示、ドライバー位置 |
| チャート | Recharts | KPI グラフ |
| アイコン | Lucide React | UI アイコン |
| データフェッチ | SWR | クライアントサイド polling |
| リアルタイム | WebSocket (native) | GPS 位置・アラート |
| DB 接続 (Snowflake) | snowflake-sdk | API Route → Snowflake 本体 |
| DB 接続 (Postgres) | pg (node-postgres) | API Route → Postgres |
| 地図タイル | Mapbox | ベースマップ |

### 環境要件

```
Node.js >= 20.x
Docker >= 24.x
Mapbox アクセストークン (https://account.mapbox.com/)
```

---

## 2. アーキテクチャ

```
┌─ Next.js App ────────────────────────────────────────────┐
│                                                           │
│  ┌─ Client (React) ────────────────────────────────────┐ │
│  │                                                      │ │
│  │  Tab 1: 明日の計画     ← /api/plan/*                │ │
│  │  Tab 2: 今日の現場     ← /api/monitor/* + WebSocket │ │
│  │  Tab 3: 振り返り       ← /api/review/*              │ │
│  │                                                      │ │
│  │  deck.gl Map + shadcn/ui Components                  │ │
│  └──────────────────────────────────────────────────────┘ │
│                                                           │
│  ┌─ Server (API Routes) ───────────────────────────────┐ │
│  │                                                      │ │
│  │  Snowflake SDK ──→ LASTMILE_DB.ANALYTICS             │ │
│  │    (リスクスコア、不在パターン、KPI、天気、異常検知)      │ │
│  │                                                      │ │
│  │  node-postgres ──→ lastmile_postgres                  │ │
│  │    (荷物、ドライバー、GPS、配達状況、ルート、渋滞)       │ │
│  │                                                      │ │
│  └──────────────────────────────────────────────────────┘ │
└───────────────────────────────────────────────────────────┘
```

### DB 接続の使い分け

| データ | 接続先 | 理由 |
|--------|--------|------|
| packages, drivers, delivery_status, driver_locations, routes, traffic_realtime, road_construction | **Postgres** | OLTP。低レイテンシで UPSERT/UPDATE が必要 |
| risk_scores, absence_patterns, weather_forecast, building_attributes, anomaly_alerts | **Snowflake** | ML 出力・Marketplace データ。バッチ更新 |
| kpi_daily, delivery_history, demand_forecast | **Snowflake** | 分析・集計データ |

---

## 3. プロジェクト構成

```
lastmile-app/
├── app/
│   ├── layout.tsx                 # ルートレイアウト (3タブナビゲーション)
│   ├── page.tsx                   # / → /plan にリダイレクト
│   ├── plan/
│   │   └── page.tsx               # Tab 1: 明日の計画
│   ├── monitor/
│   │   └── page.tsx               # Tab 2: 今日の現場
│   ├── review/
│   │   └── page.tsx               # Tab 3: 振り返り
│   ├── globals.css
│   └── api/
│       ├── plan/
│       │   ├── packages/route.ts        # GET 明日の荷物一覧
│       │   ├── drivers/route.ts         # GET ドライバー一覧
│       │   ├── risk-map/route.ts        # GET H3 リスクマップ
│       │   ├── weather/route.ts         # GET 天気予報
│       │   ├── construction/route.ts    # GET 工事情報
│       │   └── assign/route.ts          # POST 荷物割り振り
│       ├── monitor/
│       │   ├── progress/route.ts        # GET ドライバー進捗
│       │   ├── locations/route.ts       # GET 最新位置
│       │   ├── traffic/route.ts         # GET 渋滞情報
│       │   ├── alerts/route.ts          # GET 異常アラート
│       │   └── status/[packageId]/route.ts  # PUT 配達状況更新
│       ├── review/
│       │   ├── kpi/route.ts             # GET 日次 KPI
│       │   ├── driver-performance/route.ts  # GET ドライバー別実績
│       │   ├── absence-heatmap/route.ts     # GET 不在ヒートマップ
│       │   └── demand-forecast/route.ts     # GET 需要予測
│       └── ws/
│           └── route.ts                 # WebSocket ハンドラ (将来)
├── components/
│   ├── map/
│   │   ├── deck-map.tsx           # deck.gl + Mapbox ベースマップ
│   │   ├── h3-risk-layer.tsx      # H3 リスクヘキサゴンレイヤー
│   │   ├── driver-icon-layer.tsx  # ドライバー位置アイコン
│   │   ├── route-path-layer.tsx   # ルート表示レイヤー
│   │   └── traffic-layer.tsx      # 渋滞 H3 レイヤー
│   ├── plan/
│   │   ├── package-table.tsx      # 荷物一覧テーブル
│   │   ├── driver-assignment.tsx  # ドライバー割り振りパネル
│   │   ├── weather-panel.tsx      # 天気予報パネル
│   │   └── construction-list.tsx  # 工事情報リスト
│   ├── monitor/
│   │   ├── driver-status-list.tsx # ドライバー状況リスト
│   │   ├── progress-bar.tsx       # 全体進捗バー
│   │   └── alert-panel.tsx        # アラートパネル
│   ├── review/
│   │   ├── kpi-cards.tsx          # KPI サマリカード
│   │   ├── kpi-chart.tsx          # KPI トレンドチャート
│   │   ├── driver-ranking.tsx     # ドライバー別ランキング
│   │   └── absence-heatmap.tsx    # 不在ヒートマップ (H3)
│   └── shared/
│       ├── tab-navigation.tsx     # 3タブナビゲーション
│       ├── date-selector.tsx      # 日付選択
│       └── depot-header.tsx       # デポ情報ヘッダー
├── lib/
│   ├── snowflake.ts               # Snowflake 接続 (snowflake-sdk)
│   ├── postgres.ts                # Postgres 接続 (node-postgres)
│   └── utils.ts                   # ユーティリティ
├── types/
│   └── index.ts                   # 型定義
├── hooks/
│   ├── use-map-layers.ts          # 地図レイヤー管理
│   └── use-realtime.ts            # WebSocket / Polling
├── Dockerfile
├── next.config.ts
├── .env.local                     # ローカル開発用環境変数
└── package.json
```

---

## 4. データベース接続

### 4a. Snowflake 接続 (lib/snowflake.ts)

→ 接続情報・環境変数は **[docs/deployment.md](deployment.md)** を参照。

```
認証方式:
- ローカル開発: External Browser (SSO)
- SPCS: OAuth Token (/snowflake/session/token)
```

### 4b. Postgres 接続 (lib/postgres.ts)

→ 接続情報は **[docs/deployment.md](deployment.md)** を参照。

```
接続方式: node-postgres (pg) の Pool

Pool 設定:
- min: 2
- max: 10
- idleTimeoutMillis: 30000
```

### 4c. 環境変数 (.env.local)

→ **[docs/deployment.md](deployment.md)** を参照。

---

## 5. API エンドポイント一覧

### Tab 1: 明日の計画

| Method | Path | DB | 説明 |
|--------|------|-----|------|
| GET | /api/plan/packages?date= | Postgres | 指定日の荷物一覧 (packages テーブル) |
| GET | /api/plan/drivers | Postgres | ドライバー一覧 (drivers テーブル) |
| GET | /api/plan/risk-map?date=&hour=&source=sf\|pg | PG/SF デュアル | H3 リスクスコア (sf: RISK_SCORES / pg: ft_risk_scores) |
| GET | /api/plan/weather?date= | Snowflake | 天気予報 (WEATHER_FORECAST) |
| GET | /api/plan/construction?date= | Postgres | 工事情報 (road_construction) |
| POST | /api/plan/assign | Postgres | 荷物→ドライバー自動割り振り |

### Tab 2: 今日の現場

| Method | Path | DB | 説明 |
|--------|------|-----|------|
| GET | /api/monitor/progress?date= | Postgres | ドライバー別進捗 (delivery_status 集計) |
| GET | /api/monitor/locations | Postgres | ドライバー最新位置 (driver_locations) |
| GET | /api/monitor/traffic | Postgres | 渋滞情報 (traffic_realtime) |
| GET | /api/monitor/alerts?date= | Snowflake | 異常アラート (ANOMALY_ALERTS) |
| PUT | /api/monitor/status/:packageId | Postgres | 配達状況更新 |

### Tab 3: 振り返り

| Method | Path | DB | 説明 |
|--------|------|-----|------|
| GET | /api/review/kpi?date= | Snowflake | 日次 KPI (KPI_DAILY) |
| GET | /api/review/kpi?range=30 | Snowflake | KPI トレンド (過去30日) |
| GET | /api/review/driver-performance?date= | Postgres | ドライバー別実績 |
| GET | /api/review/absence-heatmap?date= | Snowflake | 不在ヒートマップ (ABSENCE_PATTERNS) |
| GET | /api/review/demand-forecast | Snowflake | 需要予測 (DEMAND_FORECAST) |

---

## 6. 主要 SQL クエリ

### 6a. H3 リスクマップ (Snowflake)

```sql
SELECT
    H3_INDEX,
    HOUR,
    RISK_SCORE,
    RISK_FACTORS
FROM LASTMILE_DB.ANALYTICS.RISK_SCORES
WHERE DATE = :date
  AND HOUR BETWEEN :startHour AND :endHour
ORDER BY RISK_SCORE DESC
```

### 6b. ドライバー進捗 (Postgres)

```sql
SELECT
    d.driver_id,
    d.name,
    COUNT(ds.package_id) AS total_packages,
    COUNT(*) FILTER (WHERE ds.status = 'delivered') AS delivered,
    COUNT(*) FILTER (WHERE ds.status = 'absent') AS absent,
    COUNT(*) FILTER (WHERE ds.status = 'in_transit') AS in_transit,
    ROUND(
        COUNT(*) FILTER (WHERE ds.status = 'delivered')::numeric
        / NULLIF(COUNT(ds.package_id), 0) * 100, 1
    ) AS progress_pct,
    dl.lat AS current_lat,
    dl.lng AS current_lng,
    dl.speed AS current_speed,
    AGE(NOW(), dl.timestamp) AS last_update_ago
FROM drivers d
LEFT JOIN delivery_status ds
    ON ds.driver_id = d.driver_id AND ds.date = :date
LEFT JOIN driver_locations dl
    ON dl.driver_id = d.driver_id
GROUP BY d.driver_id, d.name, dl.lat, dl.lng, dl.speed, dl.timestamp
ORDER BY progress_pct ASC
```

### 6c. KPI サマリ (Snowflake)

```sql
SELECT
    DATE, TOTAL_PACKAGES, DELIVERED, ABSENT,
    COMPLETION_RATE, ABSENCE_RATE, ONTIME_RATE, AVG_DELIVERY_TIME
FROM LASTMILE_DB.ANALYTICS.KPI_DAILY
WHERE DEPOT_ID = 'DEPOT-TOYOSU'
  AND DATE = :date
```

### 6d. KPI トレンド (Snowflake)

```sql
SELECT
    DATE, COMPLETION_RATE, ABSENCE_RATE, ONTIME_RATE, AVG_DELIVERY_TIME
FROM LASTMILE_DB.ANALYTICS.KPI_DAILY
WHERE DEPOT_ID = 'DEPOT-TOYOSU'
ORDER BY DATE
```

### 6e. 不在ヒートマップ (Snowflake)

```sql
SELECT
    H3_INDEX,
    DAY_OF_WEEK,
    HOUR,
    ABSENCE_RATE,
    SAMPLE_COUNT
FROM LASTMILE_DB.ANALYTICS.ABSENCE_PATTERNS
WHERE SAMPLE_COUNT >= 5
ORDER BY ABSENCE_RATE DESC
```

### 6f. 荷物一覧 (Postgres)

```sql
SELECT
    p.package_id,
    p.address,
    p.lat,
    p.lng,
    p.h3_index,
    p.time_window,
    p.weight,
    p.is_redelivery,
    p.driver_id,
    d.name AS driver_name
FROM packages p
LEFT JOIN drivers d ON d.driver_id = p.driver_id
WHERE p.date = :date
ORDER BY p.time_window, p.package_id
```

### 6g. 天気予報 (Snowflake)

```sql
SELECT
    H3_INDEX,
    DATETIME,
    PRECIPITATION,
    WIND_SPEED,
    TEMPERATURE,
    WEATHER_CODE
FROM LASTMILE_DB.ANALYTICS.WEATHER_FORECAST
WHERE DATETIME::DATE = :date
ORDER BY DATETIME
```

---

## 7. UI 設計

### デザイン方針

| 項目 | 方針 |
|------|------|
| トーン | Industrial / Operational — 業務アプリとして情報密度重視 |
| カラー | ダーク系ベースマップ + 暖色系アクセント (リスク: 赤→黄→緑) |
| フォント | Noto Sans JP (日本語対応) |
| レイアウト | 左: 地図 (60%) / 右: パネル (40%) の 2 カラム |
| レスポンシブ | デスクトップ優先 (所長が事務所 PC で使用) |

### 共通レイアウト

```
┌──────────────────────────────────────────────────┐
│  🚚 豊洲配送所  │  [計画]  [現場]  [振り返り]      │
├──────────────────────┬───────────────────────────┤
│                      │                            │
│                      │   右パネル                  │
│   地図エリア          │   (タブごとに内容が変わる)    │
│   (deck.gl)          │                            │
│                      │                            │
│                      │                            │
│                      │                            │
│                      │                            │
└──────────────────────┴───────────────────────────┘
```

### H3 カラースケール

| リスクスコア | 色 | 意味 |
|------------|-----|------|
| 0.8 - 1.0 | 赤 (#FF0000) | 高リスク |
| 0.5 - 0.8 | オレンジ (#FF8C00) | 中リスク |
| 0.3 - 0.5 | 黄 (#FFD700) | 注意 |
| 0.0 - 0.3 | 緑 (#00C853) | 低リスク |

### ドライバーステータスアイコン

| ステータス | バッジ色 | 意味 |
|-----------|---------|------|
| delivering | 緑 | 配達中 |
| moving | 青 | 移動中 |
| delayed | 赤 | 遅延 |
| break | 灰 | 休憩中 |
| completed | 紫 | 完了 |

---

## 8. 構築手順

### Step 1: プロジェクト初期化

```bash
cd /Users/ryoshida/Desktop/env/pg_lake

npx create-next-app@latest lastmile-app \
  --typescript --tailwind --eslint --app \
  --src-dir=false --import-alias="@/*"

cd lastmile-app
```

### Step 2: shadcn/ui + 依存関係

```bash
npx shadcn@latest init -d

npx shadcn@latest add \
  card chart button table select input tabs badge \
  skeleton dialog dropdown-menu separator tooltip

npm install \
  recharts@2.15.4 \
  lucide-react \
  snowflake-sdk \
  pg \
  @types/pg \
  deck.gl \
  @deck.gl/core \
  @deck.gl/layers \
  @deck.gl/geo-layers \
  @deck.gl/react \
  mapbox-gl \
  react-map-gl \
  @types/mapbox-gl \
  swr \
  h3-js
```

### Step 3: next.config.ts

```typescript
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  serverExternalPackages: ["snowflake-sdk", "pg"],
};

export default nextConfig;
```

### Step 4: DB 接続モジュール実装

- `lib/snowflake.ts` — SKILL.md のパターンに従う (SSO / OAuth 自動切替)
- `lib/postgres.ts` — node-postgres Pool

### Step 5: 型定義

`types/index.ts` に以下を定義:
- Package, Driver, DriverLocation, DeliveryStatus
- RiskScore, AbsencePattern, WeatherForecast
- KpiDaily, AnomalyAlert, DemandForecast
- TrafficRealtime, RoadConstruction

### Step 6: API Routes 実装 (優先順)

**Phase A (MVP — Tab 2 優先)**
1. `/api/monitor/progress` — ドライバー進捗
2. `/api/monitor/locations` — 最新位置
3. `/api/monitor/traffic` — 渋滞
4. `/api/monitor/alerts` — アラート

**Phase B (Tab 3)**
5. `/api/review/kpi` — KPI
6. `/api/review/driver-performance` — ドライバー実績
7. `/api/review/absence-heatmap` — 不在ヒートマップ

**Phase C (Tab 1)**
8. `/api/plan/packages` — 荷物一覧
9. `/api/plan/drivers` — ドライバー
10. `/api/plan/risk-map` — リスクマップ
11. `/api/plan/weather` — 天気
12. `/api/plan/construction` — 工事

### Step 7: 地図コンポーネント

```
実装順:
1. deck-map.tsx — Mapbox ベースマップ + deck.gl 統合
2. driver-icon-layer.tsx — ドライバー位置 (IconLayer)
3. h3-risk-layer.tsx — H3 リスクヘキサゴン (H3HexagonLayer)
4. route-path-layer.tsx — ルート表示 (PathLayer)
5. traffic-layer.tsx — 渋滞 H3 (H3HexagonLayer)
```

### Step 8: UI コンポーネント

```
Tab 2 (現場) から構築:
1. tab-navigation.tsx
2. depot-header.tsx
3. progress-bar.tsx
4. driver-status-list.tsx
5. alert-panel.tsx

Tab 3 (振り返り):
6. kpi-cards.tsx
7. kpi-chart.tsx (Recharts)
8. driver-ranking.tsx

Tab 1 (計画):
9. package-table.tsx
10. driver-assignment.tsx
11. weather-panel.tsx
12. construction-list.tsx
```

### Step 9: SWR + Polling

```
ポーリング間隔:
- ドライバー位置: 3秒
- 進捗: 10秒
- アラート: 30秒
- 渋滞: 60秒
- KPI/リスクマップ: 手動リフレッシュ
```

### Step 10: ローカルテスト

```bash
npm run dev
# → http://localhost:3000
# Snowflake SSO でブラウザ認証
# Postgres は直接接続

npm run build
# ビルド成功を確認
```

### Step 11: Docker 化

```dockerfile
FROM node:22-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:22-alpine AS runner
WORKDIR /app
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/public ./public
EXPOSE 3000
CMD ["node", "server.js"]
```

### Step 12: SPCS デプロイ

```
deploy-to-spcs スキルで実施:
1. Image Repository 作成
2. Docker build & push
3. Compute Pool 作成
4. Service 作成 (環境変数に Postgres/Snowflake 接続情報)
```

---

## 9. 制約事項と注意点

### PostGIS 未対応

- pgaudit バグにより PostGIS がインストールできない
- 空間クエリ (ST_Intersects, ST_Distance 等) は使用不可
- 代替: H3 インデックスでの空間結合 (`h3_lat_lng_to_cell` は利用可能)
- pgrouting も未対応 → ルート自動生成/リルート機能は Phase 4 待ち

### 現時点で実装可能な機能

| 機能 | 可否 | 理由 |
|------|------|------|
| H3 リスクマップ表示 | ✅ | Snowflake の RISK_SCORES テーブル |
| ドライバー位置表示 | ✅ | Postgres の driver_locations |
| 進捗モニタリング | ✅ | Postgres の delivery_status 集計 |
| KPI ダッシュボード | ✅ | Snowflake の KPI_DAILY |
| 不在ヒートマップ | ✅ | Snowflake の ABSENCE_PATTERNS |
| 天気予報オーバーレイ | ✅ | Snowflake の WEATHER_FORECAST |
| 異常アラート | ✅ | Snowflake の ANOMALY_ALERTS |
| 渋滞情報表示 | ✅ | Postgres の traffic_realtime |
| 工事情報表示 | ✅ | Postgres の road_construction |
| 荷物一覧・割り振り | ✅ | Postgres の packages + drivers |
| 需要予測表示 | ✅ | Snowflake の DEMAND_FORECAST |
| ルート自動生成 | ❌ | pgrouting (PostGIS 必須) |
| 事故影響シミュレーション | ❌ | PostGIS (ST_Intersects) 必須 |
| ルート手動ドラッグ編集 | ❌ | PostGIS 必須 |
| 計画 vs 実績ルート比較 | ❌ | PostGIS (ST_HausdorffDistance) 必須 |

### Mapbox トークン

- 地図表示には Mapbox アクセストークンが必要
- `NEXT_PUBLIC_MAPBOX_TOKEN` に設定
- 未設定時はマップなしのフォールバック UI を表示

---

## 10. テスト項目

### ローカル開発

- [ ] `npm run dev` でエラーなく起動
- [ ] Snowflake SSO 認証が通る
- [ ] Postgres 接続が成功する
- [ ] Tab 1: 荷物一覧が表示される
- [ ] Tab 1: H3 リスクマップが地図上に表示される
- [ ] Tab 2: ドライバー位置が地図上に表示される
- [ ] Tab 2: 進捗率がリアルタイム更新される
- [ ] Tab 2: アラートが表示される
- [ ] Tab 3: KPI カードが表示される
- [ ] Tab 3: KPI トレンドチャートが描画される
- [ ] Tab 3: ドライバー別ランキングが表示される
- [ ] `npm run build` が成功する

### SPCS デプロイ後

- [ ] SPCS Service がアクティブ
- [ ] OAuth トークンで Snowflake 認証が通る
- [ ] Postgres 接続が SPCS 内部ネットワーク経由で成功する
- [ ] 全 3 タブが正常に動作する

---

## 11. 工数見積

| タスク | 工数 |
|--------|------|
| プロジェクト初期化 + 環境構築 | 0.5日 |
| DB 接続モジュール (Snowflake + Postgres) | 0.5日 |
| API Routes (全 12 エンドポイント) | 1.5日 |
| 地図コンポーネント (deck.gl + Mapbox) | 1.5日 |
| Tab 2: 今日の現場 (MVP) | 1日 |
| Tab 3: 振り返り | 0.5日 |
| Tab 1: 明日の計画 | 1日 |
| ポーリング + リアルタイム更新 | 0.5日 |
| Docker + SPCS デプロイ | 1日 |
| **合計** | **8日** |

---

## 12. 既存リソース

### Snowflake (LASTMILE_DB.ANALYTICS)

| テーブル | 行数 | 用途 |
|---------|------|------|
| DELIVERY_HISTORY | 15,097 | 配送実績 (30日分) |
| RISK_SCORES | 14,608 | H3 リスクスコア |
| ABSENCE_PATTERNS | 1,413 | 不在パターン |
| BUILDING_ATTRIBUTES | 10,569 | 建物属性 |
| WEATHER_FORECAST | 192 | 天気予報 |
| KPI_DAILY | 31 | 日次 KPI |
| ANOMALY_ALERTS | 3 | 異常アラート |
| DEMAND_FORECAST | 7 | 需要予測 |

### Snowflake (LASTMILE_DB.ML)

| オブジェクト | 種別 |
|-------------|------|
| ABSENCE_PREDICTOR V1 | Model Registry (XGBoost) |
| RISK_SCORER V1 | Model Registry (LightGBM) |
| DEMAND_FORECAST_MODEL | Cortex ML FORECAST |
| ABSENCE_ANOMALY_MODEL | Cortex ML ANOMALY_DETECTION |
| TASK_DAILY_FORECAST | Task (suspended) |
| TASK_DAILY_ANOMALY | Task (suspended) |

### Postgres (lastmile_postgres)

| テーブル | 行数 | 用途 |
|---------|------|------|
| depots | 1 | 配送所マスタ |
| drivers | 12 | ドライバーマスタ |
| packages | 15,770 | 荷物 |
| delivery_status | 15,283 | 配達状況 |
| driver_locations | 12 | GPS 位置 |
| routes | 12 | ルート |
| traffic_realtime | 77 | 渋滞 |
| road_construction | 2 | 工事 |
