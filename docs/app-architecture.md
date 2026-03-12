# ラストワンマイル配送管理アプリ — 設計書

> **豊洲配送所 | 配送所長向け業務管理アプリケーション**

---

## 1. アプリ概要

| 項目 | 内容 |
|------|------|
| 名称 | lastmile-app |
| 対象ユーザー | 配送所の所長（10〜30名のドライバー管理） |
| コンセプト | 「所長の1日」を 計画→実行→振り返り の3フェーズで支援 |
| デプロイ先 | Snowpark Container Services (SPCS) — [詳細: deployment.md](deployment.md) |

---

## 2. 技術スタック

| カテゴリ | 技術 | バージョン |
|---------|------|-----------|
| フレームワーク | Next.js (App Router) | 16.1.6 |
| 言語 | TypeScript | 5.x |
| UI | React | 19.2.3 |
| コンポーネント | shadcn/ui | 4.0.2 |
| CSS | Tailwind CSS | 4.x |
| 地図 | deck.gl + react-map-gl + Mapbox GL | 9.2.11 / 8.1 / 3.19 |
| グラフ | Recharts | 2.15.4 |
| H3 | h3-js | 4.4.0 |
| データ取得 | SWR | 2.4.1 |
| アイコン | Lucide React | 0.577 |
| DB (Snowflake) | snowflake-sdk | 2.3.4 |
| DB (Postgres) | pg (node-postgres) | 8.20 |
| ダイアログ | @base-ui/react | 1.2.0 |
| デプロイ | Docker (node:22-alpine) → SPCS | — |
| ビルド | standalone output + patch-package | — |

---

## 3. アーキテクチャ

```
┌──────────────────────────────────────────────────────────────────┐
│                 SPCS (Snowpark Container Services)               │
│                                                                  │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │  Next.js App (node:22-alpine, port 8080)                   │  │
│  │                                                            │  │
│  │  ┌──────────┐  ┌─────────────┐  ┌──────────────────────┐  │  │
│  │  │ Pages    │  │ API Routes  │  │ Map Components       │  │  │
│  │  │ (5 tabs) │→ │ (22 routes) │  │ (deck.gl + Mapbox)   │  │  │
│  │  └──────────┘  └──────┬──────┘  └──────────────────────┘  │  │
│  │                       │                                    │  │
│  │            ┌──────────┴──────────┐                         │  │
│  │            ▼                     ▼                         │  │
│  │  ┌─────────────────┐  ┌─────────────────┐                 │  │
│  │  │ lib/postgres.ts  │  │ lib/snowflake.ts│                 │  │
│  │  │ (pg Pool)        │  │ (OAuth/SSO)     │                 │  │
│  │  └────────┬─────────┘  └────────┬────────┘                │  │
│  └───────────┼─────────────────────┼─────────────────────────┘  │
│              │                     │                             │
│              ▼                     ▼                             │
│  ┌───────────────────┐  ┌───────────────────────────────────┐   │
│  │ Snowflake Postgres │  │ Snowflake 本体                    │   │
│  │ (OLTP + pg_lake)   │  │ (LASTMILE_DB.ANALYTICS / ML)     │   │
│  │                    │  │ + Marketplace Views               │   │
│  │ ネイティブ 8テーブル │  │ + Managed Iceberg v3 6テーブル    │   │
│  │ + ft_* 6テーブル    │  │ + ML Model Registry              │   │
│  └───────────────────┘  └───────────────────────────────────┘   │
└──────────────────────────────────────────────────────────────────┘
```

### 認証方式

| 環境 | Snowflake | Postgres |
|------|-----------|----------|
| ローカル開発 | EXTERNALBROWSER (SSO) | env: POSTGRES_PASSWORD |
| SPCS | OAuth (`/snowflake/session/token`) | SPCS Secret 経由 |
| PAT対応 | PROGRAMMATIC_ACCESS_TOKEN (fallback) | — |

---

## 4. 画面構成

### 4.1 タブ一覧

| タブ | パス | 役割 | データ更新 |
|------|------|------|-----------|
| **計画** (Plan) | `/plan` | 前日の配車計画・リスク確認 | 手動 |
| **現場** (Monitor) | `/monitor` | 当日のリアルタイム監視 | 自動 (3〜60秒) |
| **振り返り** (Review) | `/review` | KPI分析・ML予測結果 | 手動 |
| **積み荷** (Loading) | `/loading` | 積み順表示 (LIFO) | 手動 |
| **管理** (Admin) | `/admin` | DB閲覧 (PG/SF) | 手動 |

### 4.2 計画 (Plan) — `/plan`

**目的**: 翌日の配送計画をリスクデータに基づいて策定

```
┌─────────────────────────────────────────────────────────┐
│ [日付選択]  [天候] [建物密度] [MlBadge]                    │
├────────────────────────┬────────────────────────────────┤
│                        │ 荷物テーブル                     │
│   deck.gl 地図          │  (検索・フィルタ・状態別色分け)    │
│                        ├────────────────────────────────┤
│  H3リスクスコア (色分け) │ ドライバー割当                   │
│  天候オーバーレイ (雨)   │  (配達量・スキルレベル)           │
│  工事ゾーン (黄色H3)    ├────────────────────────────────┤
│  建物密度 (紫H3)        │ 天気パネル                      │
│  [リスク凡例]           ├────────────────────────────────┤
│                        │ 工事一覧                        │
├────────────────────────┴────────────────────────────────┤
```

| レイヤー | トグル | データソース |
|---------|--------|------------|
| H3リスクスコア | 常時ON | `ft_risk_scores` (PG) |
| 天候オーバーレイ | Badge切替 | `V_WEATHER_FORECAST_LIVE` (SF) |
| 工事ゾーン | 常時ON | `road_construction` (PG) |
| 建物密度 | Badge切替 | `ft_building_attributes` (PG) |

### 4.3 現場 (Monitor) — `/monitor`

**目的**: 配送中のドライバーをリアルタイムに監視・緊急対応

```
┌─────────────────────────────────────────────────────────┐
│ [日付選択]  [MlBadge]                                     │
├────────────────────────┬────────────────────────────────┤
│                        │ 進捗バー                        │
│   deck.gl 地図          │  (全体 + ドライバー別)           │
│                        ├────────────────────────────────┤
│  ドライバー位置 (●)     │ ドライバーステータス一覧          │
│  配達ルート (線)         │  (配達数/不在/速度)             │
│  交通渋滞 (H3)          ├────────────────────────────────┤
│  インシデント影響 (H3)   │ アラートパネル                   │
│                        │  (遅延/ペース低下/不在多発/       │
│  [地図クリック→事故SIM]  │   停車検知/帰庫待ち 等)          │
├────────────────────────┴────────────────────────────────┤
```

| 自動更新 | 間隔 | 対象 |
|---------|------|------|
| ドライバー位置 | 3秒 | `/api/monitor/locations` |
| 進捗 | 10秒 | `/api/monitor/progress` |
| ルート | 30秒 | `/api/monitor/routes` |
| アラート | 15秒 | `/api/monitor/alerts` |
| 交通 | 60秒 | `/api/monitor/traffic` |

**インシデントシミュレーション**:
地図クリック → `MapClickDialog` で確認 → `/api/monitor/incident-sim` → H3 grid_disk で影響範囲算出 → 影響ドライバー・荷物・推奨アクションを日本語で表示

### 4.4 振り返り (Review) — `/review`

**目的**: 配送実績の分析とML予測結果の確認

```
┌─────────────────────────────────────────────────────────┐
│ [日付選択] [CSV出力] [ML情報カード×4]                       │
├─────────┬─────────┬─────────┬───────────────────────────┤
│ 完了率   │ 不在率   │ 時間遵守 │ 平均配達時間               │
│ (前週比) │ (前週比) │ (前週比) │ (前週比)                  │
├─────────┴─────────┴─────────┴───────────────────────────┤
│ KPIチャート (Recharts 折れ線 + 前週比較)                    │
├────────────────────────┬────────────────────────────────┤
│ ドライバーランキング     │ 需要予測チャート                 │
│ (完了率・不在数・時間)   │ (実績 + 予測 + 信頼区間)         │
│ [クリック→詳細Dialog]   │                                │
├────────────────────────┼────────────────────────────────┤
│ 不在ヒートマップ (H3 R11)│ deck.gl 地図                    │
│ [曜日/時間帯フィルタ]    │ H3AbsenceLayer (色分け)         │
└────────────────────────┴────────────────────────────────┘
```

| ML機能カード | モデル | 説明 |
|-------------|--------|------|
| 需要予測 | Cortex ML Forecast | 7日間の配送量予測 + 信頼区間 |
| 不在予測 | XGBoost (Registry) | H3 R11 ×曜日×時間帯の不在確率 (4,413セル) |
| リスクスコア | LogisticRegression + 重み | 天候/不在/建物/POI の4因子加重平均 (H3 R11) |
| 異常検知 | Cortex ML Anomaly | KPI日次の異常値検出 |

### 4.5 積み荷 (Loading) — `/loading`

**目的**: トラックへの積み込み順序表示 (LIFO = 配達逆順)

```
┌──────────────┬──────────────────────────────────────────┐
│ ドライバー一覧 │ 積み荷リスト (選択ドライバー)              │
│              │                                          │
│ [名前]       │ #1 PKG-xxx  住所  重量  体積              │
│  重量合計     │ #2 PKG-xxx  住所  重量  体積              │
│  体積合計     │ ...                                      │
│              │                                          │
│ [名前]       │ 積載率バー (重量/体積)                     │
│  ...         │                                          │
└──────────────┴──────────────────────────────────────────┘
```

### 4.6 管理 (Admin) — `/admin`

**目的**: Postgres / Snowflake テーブルのスキーマ・データ閲覧

```
┌─────────────────────────────────────────────────────────┐
│ [Postgres] [Snowflake] ← 切替トグル                       │
├──────────────┬──────────────────────────────────────────┤
│ テーブル一覧  │ カラムスキーマ + サンプルデータ (LIMIT 50)   │
│ (行数表示)    │                                          │
└──────────────┴──────────────────────────────────────────┘
```

---

## 5. API ルート一覧

### 5.1 Plan 系 (6)

| エンドポイント | メソッド | DB | テーブル | パラメータ |
|--------------|--------|-----|---------|-----------|
| `/api/plan/packages` | GET | PG | packages, delivery_status, drivers | `?date=` |
| `/api/plan/drivers` | GET | PG | drivers | — |
| `/api/plan/risk-map` | GET | PG/SF | ft_risk_scores / RISK_SCORES | `?date=&hour=&source=sf\|pg` |
| `/api/plan/weather` | GET | SF | V_WEATHER_FORECAST_LIVE | `?date=` |
| `/api/plan/construction` | GET | PG | road_construction | `?date=` |
| `/api/plan/building-density` | GET | PG/SF | ft_building_attributes + ft_delivery_history / BUILDING_ATTRIBUTES + DELIVERY_HISTORY | `?source=sf\|pg` |

### 5.2 Monitor 系 (6)

| エンドポイント | メソッド | DB | テーブル | パラメータ |
|--------------|--------|-----|---------|-----------|
| `/api/monitor/progress` | GET | PG | drivers, delivery_status, driver_locations | `?date=` |
| `/api/monitor/locations` | GET | PG | driver_locations, drivers | — |
| `/api/monitor/routes` | GET | PG | delivery_status, drivers, packages, driver_locations | `?date=&driver_id=` |
| `/api/monitor/alerts` | GET | PG | drivers, delivery_status, driver_locations | `?date=` |
| `/api/monitor/traffic` | GET | PG | traffic_realtime | — |
| `/api/monitor/incident-sim` | POST | PG | driver_locations, drivers, packages, delivery_status, traffic_realtime, road_construction | `body: {lat, lng, radius}` |

### 5.3 Review 系 (4)

| エンドポイント | メソッド | DB | テーブル | パラメータ |
|--------------|--------|-----|---------|-----------|
| `/api/review/kpi` | GET | PG | ft_kpi_daily, (fallback: delivery_status) | `?date=&range=` |
| `/api/review/driver-performance` | GET | PG | drivers, delivery_status, routes | `?date=` |
| `/api/review/absence-heatmap` | GET | PG | ft_absence_patterns | `?dow=&hour=` |
| `/api/review/demand-forecast` | GET | PG | ft_demand_forecast | — |

### 5.4 Loading 系 (1)

| エンドポイント | メソッド | DB | テーブル | パラメータ |
|--------------|--------|-----|---------|-----------|
| `/api/loading` | GET | PG | delivery_status, drivers, packages | `?date=&driver_id=` |

### 5.5 Admin 系 (4)

| エンドポイント | メソッド | DB | テーブル | パラメータ |
|--------------|--------|-----|---------|-----------|
| `/api/admin/tables` | GET | PG | pg_class, pg_namespace | — |
| `/api/admin/query` | GET | PG | (allowlist: 8 tables) | `?table=` |
| `/api/admin/snowflake-tables` | GET | SF | INFORMATION_SCHEMA.TABLES | — |
| `/api/admin/snowflake-query` | GET | SF | ANALYTICS.* / ML.* | `?table=&schema=` |

---

## 6. データソース

### 6.1 Postgres ネイティブテーブル (OLTP)

| テーブル | 用途 | 主要カラム |
|---------|------|-----------|
| drivers | ドライバーマスタ | driver_id, name, vehicle_type, skill_level |
| packages | 荷物マスタ | package_id, address, lat, lng, h3_index, time_window, weight |
| delivery_status | 配達状態 (当日) | package_id, driver_id, status, completed_at, is_absent |
| driver_locations | GPS現在位置 | driver_id, lat, lng, speed, heading |
| routes | 配達ルート | route_id, driver_id, total_distance, stop_count |
| traffic_realtime | リアルタイム渋滞 | h3_index, congestion_level, speed_ratio |
| road_construction | 工事情報 | h3_index, center_lat/lng, restriction_type |
| depots | 配送拠点 | depot_id, name, lat, lng |

### 6.2 pg_lake Foreign Table (ML出力 → S3 Parquet 直参照)

| Foreign Table | 元 Iceberg テーブル | 用途 |
|--------------|-------------------|------|
| ft_risk_scores | RISK_SCORES | 4因子リスクスコア (H3 R11 ×日×時間, 4,413セル) |
| ft_kpi_daily | KPI_DAILY | 日次KPI (完了率, 不在率等) |
| ft_absence_patterns | ABSENCE_PATTERNS | 不在パターン (H3 R11 ×曜日×時間, 4,413セル) |
| ft_demand_forecast | DEMAND_FORECAST | 7日間需要予測 + 信頼区間 |
| ft_delivery_history | DELIVERY_HISTORY | 配達履歴 (H3 R11, GEOGRAPHY付) |
| ft_building_attributes | BUILDING_ATTRIBUTES | 建物属性 (H3 R11, エレベータ, 宅配BOX等) |

### 6.3 Snowflake 直接参照 (Marketplace + 管理)

| テーブル/ビュー | 用途 |
|---------------|------|
| V_WEATHER_FORECAST_LIVE | 天気予報 (WeatherSource Marketplace) |
| INFORMATION_SCHEMA.TABLES/COLUMNS | Admin画面のテーブル閲覧 |

---

## 7. コンポーネント構成

### 7.1 ディレクトリ構造

```
src/
├── app/
│   ├── layout.tsx                 # ルートレイアウト (dark, Noto Sans JP)
│   ├── page.tsx                   # → /monitor へリダイレクト
│   ├── plan/page.tsx              # 計画画面
│   ├── monitor/page.tsx           # 現場画面
│   ├── review/page.tsx            # 振り返り画面
│   ├── loading/page.tsx           # 積み荷画面
│   ├── admin/page.tsx             # 管理画面
│   └── api/                       # 22 API ルート
│       ├── plan/       (6)
│       ├── monitor/    (6)
│       ├── review/     (4)
│       ├── loading/    (1)
│       └── admin/      (4)
├── components/
│   ├── map/                       # 地図レイヤー (9)
│   │   ├── deck-map.tsx           # DeckGL + Mapbox ラッパー
│   │   ├── deck-map-lazy.tsx      # SSR無効の遅延読込
│   │   ├── h3-risk-layer.tsx      # H3リスク/不在ヒートマップ
│   │   ├── construction-layer.tsx # 工事ゾーン (H3+ラベル)
│   │   ├── weather-layer.tsx      # 天候 (降水量H3)
│   │   ├── building-density-layer.tsx # 建物密度 (H3)
│   │   ├── route-layer.tsx        # 配達ルート (PathLayer)
│   │   ├── driver-icon-layer.tsx  # ドライバー位置 (速度色分け)
│   │   ├── traffic-layer.tsx      # 交通渋滞 (H3)
│   │   └── incident-layer.tsx     # インシデント影響 (H3)
│   ├── plan/                      # 計画画面コンポーネント (5)
│   │   ├── package-table.tsx      # 荷物一覧 (検索/フィルタ)
│   │   ├── driver-assignment.tsx  # ドライバー割当
│   │   ├── weather-panel.tsx      # 天気パネル
│   │   ├── construction-list.tsx  # 工事一覧
│   │   └── risk-legend.tsx        # リスク凡例
│   ├── monitor/                   # 現場画面コンポーネント (5)
│   │   ├── progress-bar.tsx       # 配達進捗バー
│   │   ├── driver-status-list.tsx # ドライバーステータス
│   │   ├── alert-panel.tsx        # アラートパネル (8種)
│   │   ├── incident-panel.tsx     # インシデント影響詳細
│   │   └── map-click-dialog.tsx   # 事故シミュレーション確認
│   ├── review/                    # 振り返りコンポーネント (5)
│   │   ├── kpi-cards.tsx          # KPI サマリーカード (前週比)
│   │   ├── kpi-chart.tsx          # KPI折れ線グラフ
│   │   ├── driver-ranking.tsx     # ドライバーランキング
│   │   ├── demand-forecast-chart.tsx # 需要予測 (実績+予測+CI)
│   │   └── absence-heatmap.tsx    # 不在ヒートマップ (H3)
│   ├── shared/                    # 共通コンポーネント (4)
│   │   ├── tab-navigation.tsx     # タブナビゲーション
│   │   ├── date-picker.tsx        # 日付選択
│   │   ├── ml-badge.tsx           # ML使用バッジ
│   │   └── resizable-split.tsx    # リサイズ可能分割レイアウト
│   └── ui/                        # shadcn/ui (12)
│       ├── alert-dialog, badge, button, card, dialog, input,
│       │   progress, select, separator, skeleton, table,
│       │   tabs, tooltip
│       └── ...
├── lib/
│   ├── snowflake.ts               # Snowflake 接続 (OAuth/SSO/PAT)
│   ├── postgres.ts                # Postgres 接続 (Pool)
│   ├── fetcher.ts                 # SWR用安全フェッチ
│   └── utils.ts                   # cn() ユーティリティ
└── types/
    └── index.ts                   # 全型定義 (16 interfaces)
```

### 7.2 地図レイヤー

| レイヤー | タイプ | 使用画面 | 視覚表現 |
|---------|--------|---------|---------|
| H3RiskLayer | H3HexagonLayer | Plan | 赤(高)→黄(中)→緑(低) 押出し |
| H3AbsenceLayer | H3HexagonLayer | Review | 赤(高不在)→青(低不在) |
| WeatherLayer | H3HexagonLayer | Plan | 青(降水量) |
| BuildingDensityLayer | H3HexagonLayer | Plan | 紫(密度) |
| ConstructionLayer | H3Hex + Text | Plan | 黄色 + "通行止"/"車線規制" |
| RouteLayer | PathLayer | Monitor | ドライバー色 + 時系列透過度 |
| DriverIconLayer | Scatter + Text | Monitor | 赤(停車)/黄(低速)/緑(走行) |
| TrafficLayer | H3HexagonLayer | Monitor | 赤(渋滞)→緑(順調) |
| IncidentLayer | H3HexagonLayer | Monitor | リング状影響範囲 |

---

## 8. 型定義 (TypeScript)

```
types/index.ts — 16 interfaces:

OLTP系 (PG lowercase):
  Package, Driver, DriverLocation, DeliveryStatus,
  DriverProgress, TrafficRealtime, RoadConstruction,
  Route, Depot

ML/分析系 (SF UPPERCASE):
  RiskScore, AbsencePattern, WeatherForecast,
  KpiDaily, AnomalyAlert, DemandForecast
```

---

## 9. デプロイ構成

→ **[docs/deployment.md](deployment.md)** に集約。

Docker ビルド構成:
```
Multi-stage build (node:22-alpine):
  1. deps:    npm ci + patch-package (luma.gl修正)
  2. builder: npm run build (standalone)
  3. runner:  node server.js (port 8080, UID 1001)
```

---

## 10. ML連携

### 10.1 ML パイプライン → アプリ表示

| ML出力 | モデル | Iceberg テーブル | ft_* → アプリ画面 |
|--------|--------|-----------------|-------------------|
| リスクスコア | LogisticRegression (重み) + 4因子 | RISK_SCORES (R11, 4,413セル) | ft_risk_scores → Plan地図 |
| 不在パターン | XGBoost (Registry: ABSENCE_MODEL v2) | ABSENCE_PATTERNS (R11, 4,413セル) | ft_absence_patterns → Review ヒートマップ |
| 需要予測 | LightGBM Quantile ×3 (Registry) | DEMAND_FORECAST | ft_demand_forecast → Review チャート |
| KPI | SP_ETL_POSTGRES_SYNC 集計 | KPI_DAILY | ft_kpi_daily → Review カード/チャート |
| 配達履歴 | 同上 | DELIVERY_HISTORY | ft_delivery_history → building-density |
| 建物属性 | 静的データ | BUILDING_ATTRIBUTES | ft_building_attributes → Plan密度 |

### 10.2 Task Chain (日次 23:00 JST)

```
TASK_DAILY_ETL → SP_ETL_POSTGRES_SYNC()
  ├── TASK_RISK_SCORES → SP_RECALC_RISK_SCORES()
  │     └── TASK_DEMAND_FORECAST → SP_REFRESH_DEMAND_FORECAST()
  └── TASK_ABSENCE_PATTERNS → SP_PREDICT_ABSENCE()
```

Task実行 → Iceberg v3 テーブル更新 → S3 Parquet 自動書出 → ft_* から即参照可能

### 10.3 H3 解像度

| テーブル | H3 Resolution | セル数 | 備考 |
|---------|--------------|--------|------|
| DELIVERY_HISTORY | R11 (カラム名: H3_INDEX_R9) | ~4,413 | カラム名は互換性のため未変更 |
| BUILDING_ATTRIBUTES | R11 (カラム名: H3_INDEX) | ~4,413 | |
| ABSENCE_PATTERNS | R11 | 4,413 | |
| RISK_SCORES | R11 | 4,413 | |
| V_POI_AREA_PROFILE | R8 | ~23 | POI JOIN は H3_CELL_TO_PARENT(R11, 8) |
| Postgres traffic/road | R9 | — | 事故シミュレーション専用 |

### 10.4 H3 六角形インデックスを採用するメリット

#### なぜH3か — 従来手法との比較

| 比較軸 | H3 六角形 | 緯度経度グリッド (矩形) | 行政区画 (町丁目等) |
|--------|----------|----------------------|-------------------|
| 隣接セル間の距離 | **均一** (全隣接セルが等距離) | 対角方向が √2 倍遠い | 不定 (形状がバラバラ) |
| 解像度変更 | `H3_CELL_TO_PARENT(cell, res)` で即座に粗粒度化 | 再グリッド化が必要 | 行政区画の粒度に依存 |
| 空間結合 | セル同士の整数比較 (高速) | 座標範囲の矩形交差判定 | GEOGRAPHY型のST_Contains (重い) |
| エッジ効果 | 六角形は歪みが小さい | 格子端でのクラスタ分断が起きやすい | 境界線上の配達先が曖昧 |

#### 本アプリでの具体的メリット

**1. 統一キーによるクロスデータ結合**

H3インデックスが全データソースの共通キーとして機能し、異なるテーブル間の結合を整数比較のみで実現:

```
荷物 (packages.h3_index R11)
  JOIN ft_risk_scores (h3_index R11)     → リスクスコア付与
  JOIN ft_absence_patterns (h3_index R11) → 不在率付与
  JOIN ft_building_attributes (h3_index R11) → 建物属性付与
```

GEOGRAPHY型の `ST_DWithin()` や `ST_Contains()` を使う必要がなく、クエリ性能が桁違いに高い。

**2. 解像度の階層的利用**

| 解像度 | 用途 | 1セルあたりの面積 |
|--------|------|-----------------|
| R8 (~23セル) | POIエリアプロファイル (粗い商業/住宅分類) | ~0.74 km² |
| R9 | 交通渋滞・工事情報・事故シミュレーション | ~0.105 km² |
| R10 | コスト行列 (セル間移動コスト) | ~0.015 km² |
| R11 (~4,413セル) | リスクスコア・不在予測・建物属性 (精密分析) | ~0.002 km² |

`H3_CELL_TO_PARENT(h3_index, 8)` でR11のセルをR8に集約でき、細粒度データと粗粒度データのJOINが1関数呼び出しで完結する。例: POI情報 (R8) をリスクスコア (R11) に紐付ける際に使用。

**3. 事故シミュレーションの影響範囲算出**

```sql
h3_grid_disk(center_cell, k)  -- 中心からkリングの全セルを取得
h3_grid_distance(a, b)        -- 2セル間のリング距離
```

六角形の等距離性により、`grid_disk(cell, 2)` は中心から均一な影響範囲を返す。矩形グリッドでは対角方向が過大評価される。

**4. コスト行列の効率的な事前計算**

H3 R10 のセルペアでコスト行列 (`H3_COST_MATRIX`) を構築することで:
- 配達先の正確な座標ではなくセル単位で移動コストを管理 → ペア数が `O(セル数²)` に収まる
- 新しい配達先が追加されても、同じセル内なら既存のコスト行列がそのまま利用可能
- 座標ペアごとにルーティングAPIを叩く方式と比較して、計算コストが劇的に削減

**5. Snowflake ↔ Postgres 間のデータ一貫性**

H3インデックスは決定的関数 (`h3_latlng_to_cell`) で生成されるため:
- Snowflake側で計算したH3インデックスとPostgres側のh3拡張で計算したインデックスが一致
- Iceberg → ft_* の連携でキーの変換が不要
- ただし、Postgres h3拡張とSnowflake H3関数で**まれに異なるインデックスを返すケース**があるため、本アプリではSnowflake側で統一生成し、Postgres側は参照のみとしている (既知の制約 §13参照)

**6. フロントエンド描画との親和性**

deck.gl の `H3HexagonLayer` がH3インデックスを直接受け取り六角形を描画:
- サーバーからH3インデックス+値のみ送信 → ポリゴン座標の送信が不要 (データ量削減)
- リスクマップ、不在ヒートマップ、交通渋滞、建物密度、事故影響範囲がすべて同じレイヤータイプで描画可能
- 解像度を変えるだけで地図の詳細度を動的に制御可能

---

## 11. セキュリティ

| 対策 | 実装 |
|------|------|
| SQL Injection | `query()` の `binds` パラメータ対応 + Postgres `$1` プレースホルダ |
| テーブルアクセス制御 | Admin API に allowlist (PG: 8テーブル, SF: 2スキーマ) |
| SPCS OAuth | `/snowflake/session/token` 自動更新 (10分TTL) |
| Secrets | SPCS Secret Object 経由 (env var 注入) |
| 接続プール | PG: min=2, max=10, idle=30s / SF: TTL=5min, retry on expired token |

---

## 12. 事故シミュレーション (Incident Simulation)

### 概要

現場画面 (Monitor) の地図クリックで任意地点の事故影響をシミュレーションする機能。
**全処理を Postgres 側で実行** (h3 拡張 v4.2.3)。Snowflake は使用しない。

### UX フロー

```
地図クリック → MapClickDialog (座標確認)
  → GET /api/monitor/incident-sim?lat=...&lng=...&k=2
  → IncidentLayer (H3影響範囲) + IncidentPanel (詳細)
```

### 処理フロー (API: `/api/monitor/incident-sim`)

```
Step 1: 影響セル算出
  h3_latlng_to_cell(point(lat, lng), 9)  → 中心 H3 セル (Resolution 9)
  h3_grid_disk(center, k)                → 半径 k リングの H3 セル群
  h3_grid_distance(center, cell)         → 各セルのリング距離

Step 2: 既存渋滞の重ね合わせ
  影響セル群 → h3_cell_to_parent(cell, 7) → traffic_realtime JOIN
  → セルごとの congestion_level, speed_ratio を取得

Step 3: 工事情報の重ね合わせ
  影響セル群 → road_construction JOIN (R9 + R7 親セル)
  → restriction_type を取得

Step 4: 影響重み計算 (セルごと)
  impact_weight = ringFactor × congestionFactor × constructionFactor

  ringFactor:        ring=0 → 1.0, ring=1 → 0.7, ring=2 → 0.4
  congestionFactor:  1.0 + congestion_level × 0.25 (+0.5 if speed_ratio < 0.5)
  constructionFactor: 工事あり → 1.5, なし → 1.0

Step 5: ドライバー影響分析
  driver_locations + packages + delivery_status を JOIN
  → 影響ゾーン内のドライバー or 配達先がゾーン内の荷物を持つドライバーを抽出
  → リング距離に応じた日本語 impact_detail + recommended_action を生成
```

### ドライバー影響判定ルール

| 条件 | 判定 | 推奨アクション |
|------|------|--------------|
| ring = 0 (事故地点) | 直接巻き込み | 安否確認最優先、荷物即時再割当 |
| ring = 1 (隣接) | 通行規制の直接影響 | 迂回ルート即時通知 |
| ring = 2+ (周辺) | 渋滞波及 | モニタリング、必要に応じルート変更 |
| 荷物 > 50% 影響内 | ルート大幅影響 | 他ドライバーへ再割当 |

### レスポンス構造

```json
{
  "center": { "lat", "lng", "k", "h3_index" },
  "h3_analysis": { "resolution", "total_impact_cells", "impact_area_km2", "rings[]" },
  "road_context": { "congested_cells", "construction_cells", "avg/max_impact_weight" },
  "impact_cells": [{ "h3_index", "ring", "impact_weight", "congestion_level", ... }],
  "affected_drivers": [{ "name", "distance_ring", "impact_detail", "recommended_action", ... }],
  "summary": { "total_affected_drivers", "drivers_in_zone", "total_affected_packages" }
}
```

### 使用 Postgres h3 関数

| 関数 | 用途 |
|------|------|
| `h3_latlng_to_cell(point, res)` | 座標 → H3 セル |
| `h3_grid_disk(cell, k)` | 中心から k リングの全セル |
| `h3_grid_distance(a, b)` | 2セル間のリング距離 |
| `h3_cell_to_parent(cell, res)` | 子セル → 親セル (R9→R7) |

---

## 13. 既知の制約と注意点

| 項目 | 内容 |
|------|------|
| **luma.gl patch** | `@luma.gl/core@9.2.6` に patch-package 適用 (ResizeObserver race condition) |
| **React Strict Mode** | OFF (deck.gl の二重レンダリング回避) |
| **Recharts + oklch** | shadcn/ui v4 は oklch() CSS変数 → Recharts の hsl() ラッパーと非互換。チャート色はハードコード hex |
| **Static Build** | `npm run build` はローカルで Snowflake SSO が走る → CI/CDではPAT環境変数が必要 |
| **H3互換性** | Postgres h3 と Snowflake H3 は同一座標で異なるインデックスを返す。常に片方で統一 |
| **H3_INDEX_R9 カラム名** | DELIVERY_HISTORY の `H3_INDEX_R9` は実際には R11 データ。Iceberg テーブルのカラム名変更は再作成が必要なため未変更 |
| **WH サイズ** | RYOSHIDA_WH は LARGE。R11 移行 (セル数 ×192) に伴い Medium → Large に変更済 |
