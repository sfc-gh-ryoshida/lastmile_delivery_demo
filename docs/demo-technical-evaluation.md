# ラストワンマイル配送管理アプリ — デモとしての技術的訴求ポイント評価

本ドキュメントは、このアプリが「Snowflakeデモ」として持つ技術的訴求力を、5つの軸で評価する。
単なる機能一覧ではなく、**このデモだからこそ見せられる Snowflake + Postgres の統合パターンの筋の良さ**に焦点を当てる。

---

## 総合評価

| 訴求軸 | 評価 | 一言 |
|--------|------|------|
| Snowflake Postgres の使い方 | ★★★★★ | OLTPの正しい使い所を完璧に体現 |
| pg_lake (Foreign Table) の使い方 | ★★★★★ | ゼロETLの価値を証明しつつ、SF直接参照との意図的な使い分けが秀逸 |
| ML → アプリ参照パターン | ★★★★★ | Model Registry → Iceberg → ft_* の一気通貫が秀逸 |
| Iceberg v3 の使い方 | ★★★★★ | ML出力テーブルを全てIcebergに統一した設計が模範的 |
| H3 の使い方 | ★★★★★ | 3コンテキスト (Postgres/Snowflake/Node.js) での使い分けが鮮やか |

---

## 1. Snowflake Postgres — 「OLTPはPostgresに任せる」という正しい判断

### 訴求ポイント

このデモの最大の強みは、**Snowflakeだけで全部やろうとしていない**こと。
配送管理の業務データ (荷物・ドライバー・配達ステータス・GPS位置) を Snowflake Postgres に置き、
分析/ML は Snowflake 本体に置くという**役割分担が明確**。

### 具体的な使い所

| Postgres に置いているもの | 理由 | 該当API |
|--------------------------|------|---------|
| `packages` (日次荷物) | 1リクエストで487件を即時取得する必要がある | `/api/plan/packages` |
| `delivery_status` | ドライバーが配達完了するたびに UPDATE | `/api/plan/routes/assign` |
| `driver_locations` | GPSシミュレータが1秒間隔で UPSERT | `/api/monitor/locations` |
| `traffic_realtime` | 5秒ごとの渋滞更新を受け入れる | `/api/monitor/traffic` |
| `road_construction` | 空間クエリ (H3 grid_disk) の対象 | `/api/monitor/incident-sim` |

### なぜ Snowflake 本体ではダメか

```
Monitor画面: SWRが3秒ごとにドライバー位置をポーリング
  → Snowflakeウェアハウスを3秒ごとに起動するのは非現実的
  → Postgresなら接続プール (min:2, max:10) で即座に応答
```

配達ステータスの `UPSERT` (1日数千回) もOLTP的なワークロードであり、Snowflakeの得意領域ではない。
**Postgresが正しい場所にいる**ことがデモの信頼性を高めている。

### Postgres 固有機能の活用

| 機能 | 使い方 | ファイル |
|------|--------|---------|
| **H3 extension** | `h3_latlng_to_cell()`, `h3_grid_disk()`, `h3_grid_distance()`, ネイティブ `H3INDEX` 型 | `incident-sim/route.ts` |
| **FILTER句** | `COUNT(*) FILTER (WHERE status = 'delivered')` — 1クエリで複数ステータス集計 | `kpi/route.ts`, `progress/route.ts` |
| **Trigger** | `driver_locations` への INSERT/UPDATE で `driver_locations_history` に自動記録 | `02_postgres_schema.sql` |
| **pg_cron** | 定期メンテナンス用 (拡張可) | セットアップSQL |

### デモで見せるべきストーリー

> 「Snowflakeだけでは解決できないOLTPワークロードがある。
> Snowflake Postgres は Snowflake エコシステムの中で、
> その部分を自然に埋めるコンポーネントです」

---

## 2. pg_lake (Foreign Table) + Snowflake 直接参照 — Iceberg を中心にした2経路設計

### 訴求ポイント

このデモでは、同じ Iceberg v3 テーブルに対して **2つのアクセス経路** を意図的に使い分けている。
pg_lake Foreign Table (`ft_*`) によるゼロETL参照と、Snowflake 直接参照を、
**データの鮮度要件とアクセス頻度**に応じて選択する設計。

### Iceberg v3 を中心にした2経路アーキテクチャ

```
                    Managed Iceberg v3 テーブル
                    (Single Source of Truth)
                              │
              ┌───────────────┼───────────────┐
              │                               │
              ▼                               ▼
    Snowflake Engine 経由              S3 Parquet 自動書出
    (sfQuery → Iceberg)                       │
              │                               ▼
              │                     pg_lake Foreign Table
              │                     (pgQuery → ft_*)
              │                               │
              ▼                               ▼
    ルート最適化計算のみ              Plan / Monitor / Review 全画面
    (RISK_SCORES, COST_MATRIX,       (業務CRUD + ft_* 参照)
     ABSENCE_PATTERNS の参照)
```

**Iceberg v3 が Single Source of Truth** であり、アクセス経路が異なるだけでデータの出所は同じ。

> **重要**: sfQuery は「ルート最適化計算」でのみ使用される。全画面の業務データアクセスは
> Postgres (pgQuery) が主流であり、Plan/Monitor も例外ではない。

### 2経路の使い分け — 設計意図

| 経路 | 使用API | 選択理由 |
|------|---------|----------|
| **Snowflake 直接 (sfQuery)** | `routes/generate` (RISK_SCORES, ABSENCE_PATTERNS, H3_COST_MATRIX), `readjust` (RISK_SCORES), `next-trip` (RISK_SCORES, H3_COST_MATRIX) | ルート最適化計算に必要なMLスコア+コスト行列の参照。H3_COST_MATRIX は通常テーブルのためSF直接が唯一の選択肢。同一接続で3テーブルまとめて取得する効率性 |
| **デュアルパス (?source=pg\|sf)** | `risk-map` (sf: RISK_SCORES / pg: ft_risk_scores), `building-density` (sf: BUILDING_ATTRIBUTES+DELIVERY_HISTORY / pg: ft_building_attributes+ft_delivery_history) | パフォーマンス比較用。sfがデフォルト。pgはft_*経由で同一データにアクセス |
| **pgQuery (OLTP)** | Plan: `packages`, `drivers`, `construction`, `routes/assign`, `load-confirm`, `driver-attendance`, `routes/generate`(業務データ部分) / Monitor: `locations`, `routes`, `alerts`, `progress`, `traffic`, `dwell-time`, `driver-trail`, `incident-sim`, `readjust`(業務データ部分), `next-trip`(業務データ部分), `driver-withdraw` | 全画面の業務データCRUD。Postgresプール経由で低レイテンシ |
| **pgQuery (ft_*)** | Review: `kpi` (ft_kpi_daily), `absence-heatmap` (ft_absence_patterns), `demand-forecast` (ft_demand_forecast) | ML出力データの振り返り参照。pg_lake経由でゼロETL |

> **注意**: 当初の設計意図は「Plan/Monitor = SF直接, Review = ft_*」だったが、
> 実装では **全画面が pgQuery (Postgres) 中心** となった。
> sfQuery は RISK_SCORES / ABSENCE_PATTERNS / H3_COST_MATRIX の参照に限定され、
> ルート最適化計算のピンポイントでのみ使用される。

### ABSENCE_PATTERNS — 同じテーブルが2経路で使われる実例

ABSENCE_PATTERNS は**唯一、両方のパスで使われている**テーブル。
同じ Iceberg テーブルに対して、ユースケースで経路を変えている:

```typescript
// Plan: ルート生成 → Snowflake 直接 (最新性重視)
// H3_COST_MATRIX と同じ sfQuery 接続で一括取得
const absRows = await sfQuery(
  "SELECT H3_INDEX, ABSENCE_RATE FROM ANALYTICS.ABSENCE_PATTERNS WHERE DAY_OF_WEEK = ? AND HOUR = 10"
);

// Review: 不在ヒートマップ → pg_lake ft_* (安定性重視)
// Postgres プール経由、SF障害時も最終同期データで動作
const rows = await pgQuery(
  `SELECT h3_index, day_of_week, hour, absence_rate
   FROM ft_absence_patterns WHERE sample_count >= 5`
);
```

これは偶然の重複ではなく、**Iceberg を中心にした2経路設計の象徴的な実例**。

### 全テーブルのアクセスパス一覧

| Iceberg v3 テーブル | ft_* | sfQuery 参照API | pgQuery (ft_*) 参照API |
|---|---|---|---|
| RISK_SCORES (185K行) | `ft_risk_scores` | `routes/generate`, `next-trip`, `readjust` | `risk-map` (`?source=pg`) |
| ABSENCE_PATTERNS (15K行) | `ft_absence_patterns` | `routes/generate` | `absence-heatmap` |
| KPI_DAILY (34行) | `ft_kpi_daily` | — | `review/kpi` |
| DEMAND_FORECAST (7行) | `ft_demand_forecast` | — | `review/demand-forecast` |
| DELIVERY_HISTORY (16K行) | `ft_delivery_history` | — | `building-density` (`?source=pg`) |
| BUILDING_ATTRIBUTES (11K行) | `ft_building_attributes` | — | `building-density` (`?source=pg`) |
| **H3_COST_MATRIX** | **なし (通常テーブル)** | `routes/generate`, `next-trip` | — |

> `risk-map` と `building-density` はデュアルパス対応 (`?source=pg|sf`)。sfQuery(デフォルト) で Snowflake 直接参照、pgQuery(`?source=pg`) で ft_* Foreign Table 経由参照。パフォーマンス比較用途。

H3_COST_MATRIX のみ Iceberg ではなく通常テーブル。N²×日×時間帯のデータ量が大きく、
S3 Parquet 化して Foreign Table にするのは非現実的なため、Snowflake 直接参照が唯一の選択肢。

### pg_lake ft_* のゼロETL価値

**アプリのコードが pg_lake の存在を意識していない**のが訴求ポイント。

```typescript
// src/app/api/review/absence-heatmap/route.ts
// ↓ これが Snowflake ML の出力を読んでいるとは、コードからはわからない
const rows = await pgQuery(
  `SELECT h3_index, day_of_week, hour, absence_rate
   FROM ft_absence_patterns WHERE sample_count >= 5`
);
```

開発者は「Postgres のテーブルを SELECT している」としか認識しない。
裏側で Snowflake → Iceberg → S3 → pg_lake というパイプラインが動いているが、
アプリコードへの影響はゼロ。これが**ゼロETL**の本質的な価値。

### デモで見せるべきストーリー

> 「同じ Iceberg テーブルに対して、2つのアクセス経路があります。
> 業務データは全画面で Postgres から取得し、
> ルート最適化計算に必要な ML スコアやコスト行列だけ Snowflake に直接問い合わせます。
> Review 画面では pg_lake の Foreign Table 経由で Iceberg データを読みます。
> どちらも裏側は同じ Iceberg v3 テーブル。
> データの用途に応じてアクセス経路を選べるのが、この設計の強みです」

---

## 3. ML → アプリ参照パターン — Snowflake でやるからこその価値

### 訴求ポイント

このデモの ML パイプラインは、以下の「Snowflake でなければ困難な」要素を全て活用している。

### ML モデルと Snowflake 固有技術の対応

| モデル | 手法 | Snowflake 固有技術 | アプリでの利用箇所 |
|--------|------|-------------------|-------------------|
| **不在予測** | XGBoost (Registry: `ABSENCE_MODEL v2`) | Model Registry + Iceberg 出力 | ルート順序のペナルティ計算 |
| **リスクスコア** | LogisticRegression (4因子加重) | Marketplace天候 + Iceberg建物属性 | ルート割当の優先度 |
| **需要予測** | LightGBM Quantile (3モデル) | Model Registry + 信頼区間 | Review画面の予測チャート |

### 4因子リスクスコアの構成 — 全てが Snowflake 依存

```
RISK_SCORE = w₁×weather + w₂×absence + w₃×building + w₄×poi

  weather  ← V_WEATHER_FORECAST_LIVE (Marketplace: WeatherSource)
  absence  ← ABSENCE_PATTERNS (XGBoost, Model Registry管理)
  building ← BUILDING_ATTRIBUTES (Iceberg v3, GEOGRAPHY型)
  poi      ← V_POI_AREA_PROFILE (H3 R8 空間結合)
```

| 因子 | Snowflake 固有性 | Postgres単体での代替 |
|------|-----------------|-------------------|
| 天候 (weather) | Marketplace ワンクリックでライブ気象データ | 別途 API 契約 + ETL 構築 |
| 不在率 (absence) | Model Registry でバージョン管理、SP内で推論 | 外部MLサービス + API連携 |
| 建物属性 (building) | Iceberg v3 の GEOGRAPHY 型で空間JOIN | PostGIS 必須 + データ取得手段 |
| POI (poi) | H3_CELL_TO_PARENT で解像度変換JOIN | H3拡張のみ (機能的には可能) |

### Task Chain による自動化 — 外部オーケストレータ不要

```
TASK_DAILY_ETL (毎日 23:00 JST)
  → SP_ETL_POSTGRES_SYNC()         ← Postgres実績をSnowflakeに同期
  ├── TASK_RISK_SCORES              ← 4因子リスク再計算 (185,346行)
  │     └── TASK_DEMAND_FORECAST    ← 需要予測更新
  └── TASK_ABSENCE_PATTERNS         ← 不在予測 (14,817行)
```

Airflow も cron も Step Functions もいらない。
Snowflake の Task DAG だけで、ETL → ML推論 → Iceberg書き出し → アプリ参照が完結する。

### デモで見せるべきストーリー

> 「夜間に Task Chain が回り、ML モデルがスコアを再計算し、
> Iceberg テーブルに書き出す。翌朝、アプリはそのスコアを
> 普通の SELECT で取得してルート最適化に使う。
> この一連の流れに Snowflake 以外のインフラは一切不要です」

---

## 4. Iceberg v3 — ML出力基盤としての理想形

### 訴求ポイント

全ての ML/分析出力テーブルが **Managed Iceberg v3** で統一されている。
通常の `CREATE TABLE` と全く同じ DDL で作成され、`INSERT`, `TRUNCATE`, `MERGE` が全て動作する。

### Iceberg v3 テーブル一覧と活用している v3 機能

| テーブル | 行数 | v3 機能 | S3パス |
|---------|------|---------|--------|
| RISK_SCORES | 185,346 | VARIANT (RISK_FACTORS) | `managed/risk_scores.TnfolGZJ/` |
| ABSENCE_PATTERNS | 14,817 | — | `managed/absence_patterns.RlFmqfQm/` |
| DELIVERY_HISTORY | 15,927 | GEOGRAPHY + VARIANT | `managed/delivery_history.A4hQjZs7/` |
| BUILDING_ATTRIBUTES | 10,569 | GEOGRAPHY + VARIANT | `managed/building_attributes.cpQtMdWH/` |
| KPI_DAILY | 34 | — | `managed/kpi_daily.at6hZXAP/` |
| DEMAND_FORECAST | 7 | — | `managed/demand_forecast.QgRjQeBB/` |

### なぜ通常テーブルではなく Iceberg なのか

```
通常テーブル:
  SP → 通常テーブル → (ここで止まる) → アプリから参照するには別途ETLが必要

Iceberg v3:
  SP → Iceberg テーブル → S3 Parquet 自動書出 → pg_lake ft_* で即参照
                                                   ↑ ここが自動
```

**Iceberg v3 の S3 自動書出が pg_lake の Foreign Table を成立させている。**
通常テーブルでは S3 にデータが出ないため、pg_lake で読めない。

### GEOGRAPHY 型 + VARIANT 型の実用

```sql
-- DELIVERY_HISTORY: 配達地点を GEOGRAPHY で保持
DELIVERY_LOCATION GEOGRAPHY  -- ST_MAKEPOINT(lng, lat)

-- RISK_SCORES: 4因子の内訳を VARIANT で保持
RISK_FACTORS VARIANT  -- {"weather": 0.3, "absence": 0.7, "building": 0.1, "poi": 0.05}

-- アプリ側ではフラット列で読み取り (VARIANT はSPが展開済み)
SELECT H3_INDEX, RISK_SCORE, WEATHER_RISK, ABSENCE_RISK, BUILDING_RISK, POI_RISK
FROM ANALYTICS.RISK_SCORES
```

Iceberg v3 で GEOGRAPHY と VARIANT が使えることで、Snowflake ネイティブテーブルと同じ感覚で
空間データ・半構造データを扱える。これは Iceberg v2 ではできなかった。

### デモで見せるべきストーリー

> 「Iceberg v3 テーブルは通常テーブルと完全互換です。
> GEOGRAPHY 型で空間データ、VARIANT 型で JSON を格納でき、
> しかも S3 に Parquet が自動書き出しされるので、
> 外部システムからそのままデータを読めます」

---

## 5. H3 — 3つの実行コンテキストを貫く統一空間キー

### 訴求ポイント

H3 ヘキサゴンインデックスが**Postgres/Snowflake/Node.js の全てで共通キー**として機能し、
異なるシステム間のデータを空間的に結合している。

### 3コンテキストの使い分け

| コンテキスト | ライブラリ | 解像度 | 主な用途 |
|-------------|-----------|--------|---------|
| **Postgres** | `h3` extension (v4.2.3) | R9, R7 | 事故シミュレーション (grid_disk), 交通集計 (cell_to_parent) |
| **Snowflake** | 組み込み H3 関数 | R8, R10, R11 | リスクスコア, コスト行列, POI, ML推論 |
| **Node.js** | `h3-js` npm | R10, R11 | ルート生成時にPackage座標→H3変換し、Snowflakeデータとマッチング |

### 解像度の使い分けが実務的

| 解像度 | セルサイズ | 用途 | 設計意図 |
|--------|-----------|------|---------|
| R7 | ~1.2 km | 交通集計の親セル | 広域の渋滞パターンを捉える |
| R8 | ~460 m | POI エリアプロファイル | 商業/住宅地区の特性を表現 |
| R9 | ~174 m | 事故影響範囲 (grid_disk) | ブロック単位の影響シミュレーション |
| R10 | ~65 m | H3コスト行列 (移動コスト) | 交差点粒度の経路コスト |
| R11 | ~25 m | リスクスコア/不在予測 | 建物粒度の配達リスク評価 |

### ルート生成での H3 統合パターン

```typescript
// Node.js: Package座標 → H3 R11 (リスクマッチング用)
const h3r11 = latLngToCell(pkg.lat, pkg.lng, 11);
const risk = riskMap.get(h3r11);  // Snowflake RISK_SCORES とマッチ

// Node.js: Package座標 → H3 R10 (コスト行列参照用)
const h3r10 = latLngToCell(pkg.lat, pkg.lng, 10);
const cost = costMap.get(`${fromH3r10}-${toH3r10}`);  // Snowflake H3_COST_MATRIX とマッチ

// Postgres: 事故地点 → H3 R9 → grid_disk で影響範囲
SELECT h3_grid_disk(h3_latlng_to_cell(point($2, $1), 9), $3);
```

### H3 が GPS座標の代わりになっている

従来なら「緯度経度の近傍検索」で実装する処理が、H3 の等値結合 (`WHERE h3_index = ?`) に置き換わっている。
これにより:
- **PostGIS 不要** — 空間インデックスなしで空間結合ができる
- **システム間JOIN** — Snowflake ML 出力の H3 と Postgres 業務データの H3 が直接結合できる
- **可視化が容易** — deck.gl の `H3HexagonLayer` がそのまま H3 インデックスを描画

### デモで見せるべきストーリー

> 「H3 は Uber が開発した空間インデックスで、Snowflake と Postgres の両方でネイティブサポートされています。
> このアプリでは H3 を共通キーとして、ML のリスクスコア (Snowflake) と
> 業務データ (Postgres) を空間的に結合しています。
> PostGIS がなくても空間分析ができる、H3 の実用例です」

---

## 統合アーキテクチャ図

```
┌─────────────── Snowflake ──────────────────────────────────────────┐
│                                                                     │
│  Model Registry          Marketplace         Task Chain (23:00 JST) │
│  ┌──────────────┐    ┌──────────────┐    ┌─────────────────────┐   │
│  │ABSENCE_MODEL │    │ WeatherSource│    │ TASK_DAILY_ETL      │   │
│  │(XGBoost v2)  │    │ (気象ライブ)  │    │  ├─ RISK_SCORES再計算│   │
│  │DEMAND_MODEL  │    └──────┬───────┘    │  ├─ 不在予測再計算   │   │
│  │(LightGBM ×3) │           │            │  └─ 需要予測更新     │   │
│  └──────┬───────┘           │            └──────────┬──────────┘   │
│         │ SP内で推論         │ JOINで参照              │              │
│         ▼                   ▼                        ▼              │
│  ┌─────────────────────────────────────────────────────────────┐   │
│  │  Managed Iceberg v3 Tables (ANALYTICS schema)               │   │
│  │                                                              │   │
│  │  RISK_SCORES (185K行, R11) ← 4因子ML + 学習済み重み         │   │
│  │  ABSENCE_PATTERNS (15K行, R11) ← XGBoost推論結果            │   │
│  │  H3_COST_MATRIX (R10, 通常テーブル) ← 道路ネットワーク+交通   │   │
│  │  DEMAND_FORECAST (7日) ← LightGBM信頼区間付き               │   │
│  │  KPI_DAILY (34日) ← ETL集計                                 │   │
│  │  DELIVERY_HISTORY (16K行) ← Postgres同期                    │   │
│  │  BUILDING_ATTRIBUTES (11K行) ← GEOGRAPHY + VARIANT         │   │
│  │              │                                               │   │
│  │              │ S3 Parquet 自動書出                            │   │
│  │              ▼                                               │   │
│  │         s3://ryoshida-demo/pg_lake/managed/                  │   │
│  └─────────────────────────────────────────────────────────────┘   │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
                              │
                    S3 Parquet を直接読み取り
                              │
┌─────────────── Snowflake Postgres ─────────────────────────────────┐
│                                                                     │
│  OLTP テーブル (業務データ)              pg_lake Foreign Tables      │
│  ┌─────────────────────────┐    ┌─────────────────────────────┐   │
│  │ packages (487件/日)      │    │ ft_risk_scores              │   │
│  │ drivers (12名)           │    │ ft_absence_patterns         │   │
│  │ delivery_status (更新多) │    │ ft_kpi_daily                │   │
│  │ driver_locations (3秒更新)│    │ ft_demand_forecast          │   │
│  │ traffic_realtime (5秒更新)│    │ ft_delivery_history         │   │
│  │ road_construction        │    │ ft_building_attributes      │   │
│  │ driver_locations_history │    │                             │   │
│  │ routes                   │    │ (pgQuery() で参照           │   │
│  └────────┬────────────────┘    │  = 全画面で使用)            │   │
│           │                      └──────────────┬──────────────┘   │
│           │                                     │                   │
│      H3 extension                          ゼロETL                  │
│    (grid_disk, grid_distance,              (開発者は Snowflake の    │
│     cell_to_parent, H3INDEX型)              存在を意識しない)        │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
                              │
                   pgQuery() / sfQuery()
                              │
┌─────────────── Next.js App (SPCS) ─────────────────────────────────┐
│                                                                     │
│  Plan (計画)         Monitor (現場)        Review (振り返り)         │
│  ┌─────────────┐    ┌──────────────┐      ┌──────────────────┐    │
│  │ルート生成     │    │GPS位置追跡    │      │KPIトレンド        │    │
│  │ pgQuery:    │    │(Postgres 3秒) │      │(ft_kpi_daily)    │    │
│  │  packages   │    │事故シミュ     │      │不在ヒートマップ    │    │
│  │  drivers    │    │(H3 grid_disk) │      │(ft_absence_pat.) │    │
│  │  status     │    │渋滞・滞留     │      │ドライバー実績     │    │
│  │ sfQuery:    │    │(Postgres)     │      │(ft_delivery_hist)│    │
│  │  RISK_SCORES│    │ルート再調整    │      │需要予測           │    │
│  │  ABS_PAT.   │    │ pgQuery+sfQ  │      │(ft_demand_fore.) │    │
│  │  COST_MATRIX│    │次便生成       │      │                  │    │
│  │リスクマップ   │    │ pgQuery+sfQ  │      │← 全てpg_lake経由  │    │
│  │ (SF直接)    │    │              │      │← 安定性重視       │    │
│  │             │    │              │      │                  │    │
│  │← pgQuery主体│    │← pgQuery主体 │      │← pgQuery(ft_*)   │    │
│  │  sfQ=最適化 │    │  sfQ=最適化  │      │  のみ             │    │
│  └─────────────┘    └──────────────┘      └──────────────────┘    │
│                                                                     │
│  h3-js: Node.jsでH3変換 → Snowflake/Postgresデータとマッチング      │
│  deck.gl: H3HexagonLayer でヘキサゴン可視化                         │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

---

## Graceful Degradation — Snowflake が落ちても動く設計

このデモの隠れた訴求ポイント。Snowflake 由来の各データソースが**独立した try-catch**で保護されている。

| 障害 | 影響 | アプリの動作 |
|------|------|-------------|
| Snowflake 全ダウン | ML出力・コスト行列なし | Postgres データのみで容量制約+最近傍法ルート生成。**動作は継続** |
| RISK_SCORES のみ障害 | リスク考慮なし | ルート順序のリスクペナルティ無効化。他は正常 |
| H3_COST_MATRIX のみ障害 | 実道路コストなし | Haversine (直線距離) にフォールバック |
| S3 障害 | ft_* 読み取り不可 | Review画面がPGフォールバック (delivery_statusから直接集計) |

**pg_lake の追加的な耐障害性**: ft_* は S3 の Parquet を直接読むため、Snowflake 本体が落ちていても
最終同期時点のデータで動作可能。

---

## まとめ: このデモが証明していること

| 証明していること | 従来のアプローチ | このデモのアプローチ |
|-----------------|-----------------|-------------------|
| **OLTP と分析の共存** | 1つのDBに全部入れて性能問題 | Postgres (OLTP) + Snowflake (分析) の適材適所 |
| **ML出力のアプリ連携** | Airflow + ETLパイプライン + モデルサービング | Task Chain → Iceberg → pg_lake で自動連携 |
| **同一データへの2経路** | 全クライアントが同じパスでアクセス | Iceberg を SSoT として、鮮度要件で SF直接 / ft_* を使い分け |
| **空間データの統合** | PostGIS 必須、システム間は緯度経度で結合 | H3 が共通キー、3コンテキストで互換 |
| **気象データの取得** | API契約 + ETL + データ変換 | Marketplace で SQL 1文 |
| **障害時の継続性** | 依存サービス障害でシステム停止 | 段階的縮退で動作継続 |

**このデモは「Snowflake + Postgres + Iceberg + pg_lake + H3」の統合パターンの模範実装であり、
各技術が単独ではなく組み合わせることで生まれる価値を、実動するアプリケーションとして証明している。**
