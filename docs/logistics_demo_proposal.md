# ラストワンマイル配送所長アプリ デモ企画書

## Snowflake で実現する「所長の1日」 — 計画・実行・振り返り

> **配車計画 90分 → 5分。所長の勘をデータに置き換える。**

---

## 1. デモ概要

| 項目 | 内容 |
|------|------|
| 対象顧客 | ラストワンマイル配送を運営する企業（宅配、EC物流、3PL） |
| ペルソナ | **配送所の所長**（10〜30名のドライバーを管理、日次で計画・指示・判断を行う） |
| テーマ | 所長の1日の業務を「前日計画 → 当日モニタリング → 振り返り」の3画面で支援するアプリ |
| キーメッセージ | 勘と経験に頼っていた配車・ルート計画を、Snowflake 上の ML + H3 + PostGIS でデータドリブンに変える |
| 所要時間 | 20分（デモ）+ 10分（Q&A） |

### 既存ルート最適化 SaaS との差別化

| 観点 | 既存 SaaS (Locus, Onfleet 等) | このアプリ (Snowflake) |
|------|-------------------------------|----------------------|
| データの所在 | SaaS 側に送信 | 自社 Snowflake 内で完結。データが外に出ない |
| 外部データ連携 | 限定的（天気程度） | Marketplace で気象・交通・建物属性を即統合 |
| ML カスタマイズ | ブラックボックス | 自社データで不在予測モデルを構築・改善可能 |
| 分析・振り返り | 別ツールが必要 | 同一プラットフォームで KPI 分析まで完結 |
| GIS 拡張性 | SaaS の機能範囲内 | PostGIS + H3 + pgrouting + KML/GeoJSON で自由に拡張 |
| リアルタイム OLTP | API 経由のみ | Snowflake Postgres で GPS/ステータスを直接管理 |

---

## 2. 配送所長の課題（ペインポイント）

### 前日計画

| 課題 | 現状 |
|------|------|
| ドライバーへの荷物割り振りが属人的 | ベテラン所長の勘に依存。引き継ぎ困難 |
| ルート決めに外部情報が反映されない | 翌日の天気・工事情報を見ながら手作業で調整 |
| 積み順の整理が手間 | ルートと連動した逆順積みの計算を手作業で実施 |
| 時間指定・再配達の組み込みが複雑 | 午前指定、再配達分を手動でルートに差し込み |

### 当日実行

| 課題 | 現状 |
|------|------|
| ドライバーの状況が見えない | 電話確認に頼る。全体の進捗が把握できない |
| 突発事象への対応が遅い | 渋滞・工事発生を知るのはドライバーからの連絡後 |
| 不在発生時のリルートができない | 不在が重なっても配送順を変更できず非効率に |

### 振り返り

| 課題 | 現状 |
|------|------|
| KPI が取れていない | 完了率・不在率・時間指定遵守率を手集計 |
| 改善サイクルが回らない | 過去データの分析環境がなく、翌日の計画に反映できない |

---

## 3. システム構成 — 3つのコンポーネント

本デモは **役割ごとに最適なコンポーネント** を組み合わせ、全て Snowflake プラットフォーム内で完結させる。

| コンポーネント | 対象ユーザー | 役割 | データ接続先 |
|--------------|------------|------|-------------|
| **React アプリ (SPCS)** | 配送所長・現場 | 業務アプリ（計画・実行・振り返り） | → **Postgres** 直結（操業データ＋pg_lake Foreign Table でMLデータ参照） |
| **Streamlit in Snowflake** | データチーム・マネジメント | ML 可視化・KPI 分析・モデルモニタリング | → **Snowflake 本体** 直結 |
| **Snowflake Notebook** | データサイエンティスト | モデル開発・学習・検証 | → **Snowflake 本体** |

### データフローの原則

```
操業データ (OLTP):
  Postgres ネイティブテーブル (drivers, packages, delivery_status 等)
  → アプリから直接 SELECT / INSERT / UPDATE

MLアウトプット:
  Task Chain (日次) → SP が Managed Iceberg v3 テーブルに直接書き込み
  Iceberg テーブル更新 → S3 Parquet 自動更新
  → pg_lake Foreign Table (ft_*) から即参照可能
```

> **Note**: ANALYTICS テーブルは全て Managed Iceberg v3 に統合済み。二重管理 (旧 ANALYTICS + ICE_*) は廃止。SP が直接 Iceberg テーブルに書き込む。

- **React アプリ (SPCS) は Postgres に直結**する。操業データはネイティブテーブル、ML出力は pg_lake Foreign Table で参照
- **Streamlit in Snowflake は Snowflake 本体に直結**する。Postgres には接続しない
- Snowflake 本体と Postgres の間は **Managed Iceberg v3 (S3 Parquet) + pg_lake Foreign Table** でデータを共有する
- Foreign Table は **同期不要** — Iceberg テーブルが更新されれば S3 Parquet が自動更新され、ft_* から即参照可能
- SP が直接 Iceberg テーブルに書き込むため、同期ジョブ不要

---

## 4. アーキテクチャ

```
┌──────────────────────────────────────────────────────────────────────┐
│                        Snowflake Platform                             │
│                                                                       │
│  ┌─────────────────────────────────────────────────────────────┐     │
│  │  Snowflake 本体 (分析・ML 基盤)                              │     │
│  │                                                              │     │
│  │  Notebook      : モデル開発・学習 (Snowpark ML)              │     │
│  │  Model Registry : モデルバージョン管理                        │     │
│  │  Cortex ML     : 需要予測 (FORECAST)                         │     │
│  │  SQL UDF       : バッチ推論 (リスクスコア / 不在予測)         │     │
│  │  H3 関数       : バッチでのメッシュ集計                       │     │
│  │  Marketplace   : 気象 / 交通 / 建物属性データ                 │     │
│  │  Task Chain    : 日次バッチ (ETL → スコアリング → 予測)       │     │
│  │                                                              │     │
│  │  [Managed Iceberg v3 Tables (ANALYTICS)]                    │     │
│  │    ・RISK_SCORES (H3セル別リスクスコア, VARIANT+GEOGRAPHY)    │     │
│  │    ・KPI_DAILY (日次KPI集計)                                  │     │
│  │    ・ABSENCE_PATTERNS (不在パターン)                          │     │
│  │    ・DEMAND_FORECAST (需要予測)                               │     │
│  │    ・DELIVERY_HISTORY (配送履歴, GEOGRAPHY+VARIANT)           │     │
│  │    ・BUILDING_ATTRIBUTES (建物属性, GEOGRAPHY+VARIANT)        │     │
│  │    → Task Chain で SP が直接書き込み                        │     │
│  │    → S3 Parquet 自動生成 → ft_* から即参照                 │     │
│  └──────────────────────┬───────────────────────────────────────┘     │
│                         │                                             │
│                         │  S3 Parquet (自動生成)                      │
│                         │  s3://ryoshida-demo/pg_lake/managed/        │
│                         │                                             │
│          ┌──────────────┤                                             │
│          │              │                                             │
│          ▼              ▼                                             │
│  ┌────────────────┐  ┌──────────────────────────────────────────┐   │
│  │ Streamlit in   │  │  Snowflake Postgres (OLTP + GIS)         │   │
│  │ Snowflake      │  │                                          │   │
│  │                │  │  [pg_lake Foreign Table — ML出力参照]     │   │
│  │ Snowflake 本体 │  │    ft_risk_scores     → S3 Parquet 直参照│   │
│  │ に直結         │  │    ft_kpi_daily       → S3 Parquet 直参照│   │
│  │                │  │    ft_absence_patterns→ S3 Parquet 直参照│   │
│  │ ・ML モデル    │  │    ft_demand_forecast → S3 Parquet 直参照│   │
│  │   精度監視     │  │                                          │   │
│  │ ・KPI トレンド │  │  [ネイティブテーブル — 操業データ]        │   │
│  │ ・不在パターン │  │    packages, drivers, delivery_status     │   │
│  │   可視化       │  │    driver_locations, routes               │   │
│  │ ・リスクスコア │  │    traffic_realtime, road_construction    │   │
│  │   分布         │  │                                          │   │
│  │ ・A/Bテスト    │  │  [拡張]                                  │   │
│  │   結果比較     │  │    pg_lake, h3, h3_postgis, postgis      │   │
│  │                │  │    pgrouting (将来), pg_cron              │   │
│  └────────────────┘  └──────────────────────┬───────────────────┘   │
│                                              │                       │
│                                              ▼                       │
│                       ┌──────────────────────────────────────────┐   │
│                       │  SPCS: 所長アプリ (Next.js)              │   │
│                       │                                          │   │
│                       │  Next.js App Router → Postgres 直結      │   │
│                       │    操業データ: ネイティブテーブル          │   │
│                       │    ML出力: ft_* Foreign Table             │   │
│                       │                                          │   │
│                       │  deck.gl / Mapbox GL JS                  │   │
│                       │  ・H3 リスクマップ                        │   │
│                       │  ・リアルタイム地図                        │   │
│                       │  ・不在ヒートマップ                        │   │
│                       │  ・KPI ダッシュボード                      │   │
│                       └──────────────────────────────────────────┘   │
└──────────────────────────────────────────────────────────────────────┘
```

### データアクセスパターン

| データ種別 | テーブル | アクセス元 | 方式 |
|-----------|---------|-----------|------|
| 操業データ (OLTP) | packages, drivers, delivery_status, driver_locations 等 | React アプリ | Postgres ネイティブテーブル直接 |
| ML出力: リスクスコア | ft_risk_scores | React アプリ | pg_lake Foreign Table → S3 Parquet |
| ML出力: KPI集計 | ft_kpi_daily | React アプリ | pg_lake Foreign Table → S3 Parquet |
| ML出力: 不在パターン | ft_absence_patterns | React アプリ | pg_lake Foreign Table → S3 Parquet |
| ML出力: 需要予測 | ft_demand_forecast | React アプリ | pg_lake Foreign Table → S3 Parquet |
| 天気予報 | V_WEATHER_FORECAST_LIVE | React アプリ | Snowflake 直接 (Cortex LLM) |
| 分析・可視化 | ANALYTICS テーブル全般 | Streamlit | Snowflake 本体直結 |

### pg_lake Foreign Table のメリット

| 観点 | 旧: COPY方式 (sf_*) | 現: Foreign Table方式 (ft_*) |
|------|---------------------|------------------------------|
| データ鮮度 | スナップショット（日次 COPY 必要） | 常に最新（S3 Parquet 直参照） |
| 同期処理 | SP_REFRESH_PG_FROM_ICEBERG が必要 | 不要 |
| Task Chain 追加 | 必要 | 不要 |
| ストレージ | Postgres 側に重複保持 | なし（S3 のみ） |
| レイテンシ | 低い（ローカル読み取り） | やや高い（都度 S3 読み取り） |
| 運用コスト | 高い（同期ジョブ管理） | 低い（設定のみ） |

---

## 5. 所長アプリ (React + SPCS) — 3画面構成

### 技術スタック

| 技術 | バージョン | 用途 |
|------|-----------|------|
| Next.js | 16.1.6 (App Router, Turbopack) | フレームワーク |
| React | 19.2.3 | UI |
| deck.gl | 9.2.11 | 地図可視化 (H3HexagonLayer, GeoJsonLayer, IconLayer) |
| Mapbox GL JS | 3.19.1 | ベースマップ |
| shadcn/ui | v4 (@base-ui/react ベース) | UI コンポーネント |
| pg (node-postgres) | - | Postgres 接続 |
| snowflake-sdk | - | Snowflake 接続 (天気・管理画面のみ) |

### デプロイ

→ **[docs/deployment.md](deployment.md)** を参照。

### Tab 1: 明日の計画（前日 16:00〜18:00 に使用）

**所長のゴール:** 明日の配送を最適に段取りし、ドライバーに指示を出す

```
┌─────────────────────────────────────────────────────────┐
│ [明日の計画]  2026/03/10(火)  荷物数: 487件  車両: 12台   │
├──────────────────────┬──────────────────────────────────┤
│                      │  ドライバー割り振り               │
│   H3 リスクマップ     │  ┌────────────────────────────┐ │
│   (deck.gl H3Layer)  │  │ 田中  エリアA  52件  ■■■■  │ │
│                      │  │ 佐藤  エリアB  48件  ■■■□  │ │
│   ● 配送先ポイント    │  │ 鈴木  エリアC  41件  ■■■□  │ │
│   ■ リスク高エリア    │  └────────────────────────────┘ │
│   ▲ 工事・規制        │                                  │
│                      │  天気予報 (Cortex LLM)            │
│                      │  [ルート自動生成] [積み順出力]     │
└──────────────────────┴──────────────────────────────────┘
```

| 機能 | データソース | 技術 |
|------|-------------|------|
| H3 リスクマップ | ft_risk_scores (pg_lake Foreign Table) | deck.gl H3HexagonLayer |
| 天気予報 | V_WEATHER_FORECAST_LIVE (Snowflake Cortex LLM) | Snowflake 直接クエリ |
| ドライバー・荷物一覧 | packages, drivers (Postgres ネイティブ) | Postgres 直接 |

### Tab 2: 今日の現場（当日 8:00〜19:00 に使用）

**所長のゴール:** 全ドライバーの状況をリアルタイムに把握し、問題に即対応する

```
┌─────────────────────────────────────────────────────────┐
│ [今日の現場]  2026/03/10(火)  進捗: 312/487件 (64.1%)    │
├──────────────────────┬──────────────────────────────────┤
│                      │  ドライバー状況                   │
│   リアルタイム地図     │  ┌────────────────────────────┐ │
│                      │  │ 🟢 田中  配達中  38/52件    │ │
│   ● ドライバー位置    │  │ 🟡 佐藤  移動中  29/48件    │ │
│   ● 配達完了          │  │ 🔴 鈴木  遅延    18/41件    │ │
│   ● 不在              │  └────────────────────────────┘ │
│   ■ 渋滞エリア(H3)    │                                  │
│   ▲ 工事・事故        │  アラート                        │
│                      │  ┌────────────────────────────┐ │
│                      │  │ ⚠ 鈴木: 配送ペース異常低下  │ │
│                      │  │ ⚠ エリアC: 渋滞発生         │ │
│                      │  └────────────────────────────┘ │
└──────────────────────┴──────────────────────────────────┘
```

| 機能 | データソース | 技術 |
|------|-------------|------|
| ドライバー位置 | driver_locations (Postgres ネイティブ) | deck.gl IconLayer |
| 進捗率 | delivery_status (Postgres ネイティブ) | Postgres 集計 |
| 渋滞情報 | traffic_realtime (Postgres ネイティブ) | deck.gl H3HexagonLayer |
| 工事情報 | road_construction (Postgres ネイティブ) | deck.gl GeoJsonLayer |
| 事故シミュレーション | h3 + PostGIS | h3_grid_disk + ST_Intersects |

### Tab 3: 振り返り（当日 18:00〜翌朝に使用）

**所長のゴール:** 今日の実績を把握し、明日の計画精度を上げる

```
┌─────────────────────────────────────────────────────────┐
│ [振り返り]  2026/03/10(火)  最終実績                      │
├──────────────────────┬──────────────────────────────────┤
│                      │  KPI サマリ                       │
│   H3 不在ヒートマップ │  ┌────────────────────────────┐ │
│   (deck.gl H3Layer)  │  │ 配達完了率:  94.3%         │ │
│                      │  │ 不在率:      12.1%         │ │
│                      │  │ 時間指定遵守率: 97.8%      │ │
│                      │  │ 平均配達時間: 4.2分/件     │ │
│                      │  └────────────────────────────┘ │
│                      │                                  │
│                      │  需要予測 (7日間)                 │
│                      │  ┌────────────────────────────┐ │
│                      │  │ (棒グラフ + 信頼区間)       │ │
│                      │  └────────────────────────────┘ │
└──────────────────────┴──────────────────────────────────┘
```

| 機能 | データソース | 技術 |
|------|-------------|------|
| KPI ダッシュボード | ft_kpi_daily / delivery_status fallback | pg_lake Foreign Table |
| 不在ヒートマップ | ft_absence_patterns | pg_lake Foreign Table |
| 需要予測 | ft_demand_forecast | pg_lake Foreign Table |

---

## 6. Snowflake 環境構成

### 接続情報

→ **[docs/deployment.md](deployment.md)** を参照。

| 項目 | 値 |
|------|----|
| アカウント | SFSEAPAC-FSI_JAPAN |
| データベース | LASTMILE_DB |
| スキーマ | ANALYTICS, ML, RAW, SPCS, PUBLIC |

### Managed Iceberg v3 Tables (LASTMILE_DB.ANALYTICS)

| テーブル | S3 Base Location | 行数 | v3 機能 |
|---------|-----------------|------|--------|
| RISK_SCORES | `managed/risk_scores.TnfolGZJ/` | 15,574 | VARIANT (RISK_FACTORS) + フラットカラム |
| KPI_DAILY | `managed/kpi_daily.at6hZXAP/` | 34 | — |
| ABSENCE_PATTERNS | `managed/absence_patterns.RlFmqfQm/` | 1,567 | — |
| DEMAND_FORECAST | `managed/demand_forecast.QgRjQeBB/` | 7 | — |
| DELIVERY_HISTORY | `managed/delivery_history.A4hQjZs7/` | 15,927 | GEOGRAPHY (DELIVERY_LOCATION) + VARIANT (METADATA) |
| BUILDING_ATTRIBUTES | `managed/building_attributes.cpQtMdWH/` | 10,569 | GEOGRAPHY (CENTROID) + VARIANT (BUILDING_DETAILS) |

### External Volume / Catalog Integration

| リソース | 設定 |
|---------|------|
| External Volume | `PG_LAKE_ICEBERG_VOL` (ALLOW_WRITES=TRUE) |
| Storage | `s3://ryoshida-demo/pg_lake/` |
| Catalog Integration | `PG_LAKE_ICEBERG_CATALOG` (OBJECT_STORE, ICEBERG) |

### Task Chain

```
TASK_DAILY_ETL (23:00 JST)
  ├─→ TASK_RISK_SCORES → SP_RECALC_RISK_SCORES()
  │     └─→ TASK_DEMAND_FORECAST → SP_REFRESH_DEMAND_FORECAST()
  └─→ TASK_ABSENCE_PATTERNS → SP_PREDICT_ABSENCE()
```

SP が直接 Iceberg v3 テーブルに書き込むため、同期タスク (旧 TASK_SYNC_ICEBERG) は不要。

### 主要ストアドプロシージャ

#### 本番パイプライン (Task Chain から呼び出し)

| SP | スキーマ | 言語 | 書き込み先 | 読み取り元 | 役割 |
|----|---------|------|-----------|-----------|------|
| SP_ETL_POSTGRES_SYNC | ANALYTICS | Python | DELIVERY_HISTORY, KPI_DAILY | Postgres: delivery_status, packages | **Postgres → Snowflake ETL**。Postgres の配達実績を Snowflake Iceberg に取り込み。DELIVERY_LOCATION (GEOGRAPHY) + METADATA (VARIANT) 生成 |
| SP_RECALC_RISK_SCORES | ANALYTICS | Python | RISK_SCORES | ABSENCE_PATTERNS, BUILDING_ATTRIBUTES, V_WEATHER_FORECAST_LIVE, V_POI_AREA_PROFILE, ML.RISK_WEIGHTS | **リスクスコア計算**。4因子 (天気/不在/建物/POI) を加重合成。フラットカラム + RISK_FACTORS (VARIANT) 両方書き込み |
| SP_PREDICT_ABSENCE | ML | Python | ABSENCE_PATTERNS | DELIVERY_HISTORY, BUILDING_ATTRIBUTES, V_WEATHER_HISTORY, V_POI_AREA_PROFILE, ML.ABSENCE_MODEL (v2) | **不在予測**。XGBoost モデルで H3セル×曜日×時間帯の不在確率を推論。TRUNCATE → INSERT |
| SP_REFRESH_DEMAND_FORECAST | ANALYTICS | Python | DEMAND_FORECAST | V_WEATHER_FORECAST_LIVE, ML.DEMAND_MODEL_{LOWER,MEDIAN,UPPER} | **需要予測**。LightGBM 分位点回帰で 7日先の荷量を予測。DELETE → INSERT |

#### ユーティリティ (手動実行)

| SP | スキーマ | 役割 |
|----|---------|------|
| SP_SETUP_FOREIGN_TABLES | ANALYTICS | Postgres に pg_lake Foreign Table (ft_*) を 6テーブル作成。Iceberg の S3 パスを設定 |
| SP_REGENERATE_DEMO_DATA | ANALYTICS | デモ用の Postgres テストデータを再生成 |
| SP_POPULATE_ROUTES | ANALYTICS | Postgres routes テーブルにルートデータを投入 |

#### ML モデル学習 (Notebook/手動)

| SP | スキーマ | 役割 |
|----|---------|------|
| SP_TRAIN_ABSENCE_MODEL | ML | XGBoost 不在予測モデルを学習し Model Registry に登録 |
| SP_TRAIN_DEMAND_MODEL | ML | LightGBM 需要予測モデル (3本: lower/median/upper) を学習・登録 |
| SP_TRAIN_RISK_MODEL | ML | LightGBM リスクスコアモデルを学習・登録 |
| SP_DETECT_ANOMALIES | ML | 配送異常検知 (M4 用、未運用) |

#### 調査・デバッグ用 (クリーンアップ候補)

| SP | スキーマ | 備考 |
|----|---------|------|
| SP_CHECK_PG_H3 | ANALYTICS | Postgres h3 vs Snowflake H3 の不一致調査用 |
| SP_CHECK_V2_PARQUET | ANALYTICS | Iceberg v2 Parquet ファイル検査用 |
| SP_CREATE_LOCATION_HISTORY | ANALYTICS | driver_locations_history テーブル作成用 |
| SP_DEBUG_RISK_PARQUET | ANALYTICS | リスクスコア Parquet デバッグ用 |
| SP_DROP_SF_TABLES | ANALYTICS | Postgres 旧テーブル削除用 |
| SP_EXPAND_TRAFFIC_DATA | ANALYTICS | traffic_realtime データ拡張用 |
| SP_FIND_MANAGED_METADATA | ANALYTICS | Iceberg メタデータ検索用 |
| SP_FIND_METADATA_FILES | ANALYTICS | Iceberg メタデータファイル検索用 |
| SP_FIX_DELIVERY_STATUS_PK | ANALYTICS | delivery_status PK 修正用 |
| SP_FIX_PG_H3_INDEX | ANALYTICS | Postgres H3 インデックス修正用 |
| SP_LATEST_METADATA | ANALYTICS | Iceberg 最新メタデータ取得用 |
| SP_LOAD_RISK_SCORES_PG | ANALYTICS | Postgres にリスクスコア直接ロード用 |
| SP_LOAD_RISK_V2 | ANALYTICS | ICE v2 リスクスコアロード用 |
| SP_PG_CHECK_LAKE_SCAN | ANALYTICS | pg_lake スキャン確認用 |
| SP_PG_DATA_AUDIT | ANALYTICS | Postgres データ監査用 |
| SP_PG_SCHEMA_REVIEW | ANALYTICS | Postgres スキーマレビュー用 |
| SP_RECALC_ABSENCE_PATTERNS | ANALYTICS | 旧版不在パターン計算 (SP_PREDICT_ABSENCE に置換済) |
| SP_VERIFY_ROUTES | ANALYTICS | ルートデータ検証用 |
| SP_DEBUG_ABSENCE / SP_DEBUG_ABSENCE2 | ML | 不在予測デバッグ用 |
| SP_REFRESH_DEMAND_FORECAST (ML版) | ML | ANALYTICS版と重複。旧版 |

### Views

| View | 役割 | データソース |
|------|------|-------------|
| V_WEATHER_FORECAST_LIVE | 天気予報 (リアルタイム) | ZTS_WEATHERSOURCE Marketplace |
| V_WEATHER_HISTORY | 天気実績 (過去) | ZTS_WEATHERSOURCE Marketplace |
| V_POI_AREA_PROFILE | POI エリア分類 (res8) | ZTS_SAFEGRAPH Marketplace |

### ML Models (LASTMILE_DB.ML Registry)

| モデル | 手法 | メトリクス | ターゲット |
|--------|------|-----------|-----------|
| ABSENCE_PREDICTOR V1 | XGBoost | AUC 0.759 | SPCS のみ (再登録予定) |
| RISK_SCORER V1 | LightGBM | - | WAREHOUSE |
| DEMAND_MODEL_{LOWER,MEDIAN,UPPER} | Quantile Regression | - | WAREHOUSE |

---

## 6.5 データパイプライン全体像

### 概要

```
┌───────────────────────────────────────────────────────────────────────────┐
│                        データフロー全体図                                    │
│                                                                           │
│  Postgres (OLTP)                    Snowflake (分析・ML)                   │
│                                                                           │
│  ┌──────────────────────┐          ┌────────────────────────────────────┐ │
│  │ ネイティブテーブル      │          │                                    │ │
│  │  drivers              │  SP_ETL │ DELIVERY_HISTORY (Iceberg v3)      │ │
│  │  packages        ─────┼─POSTGRES│ KPI_DAILY        (Iceberg v3)      │ │
│  │  delivery_status      │ _SYNC  │                                    │ │
│  │  driver_locations     │(psycopg2│ + Marketplace (天気/POI)            │ │
│  │  routes               │ 日次)──▶│ + ML Models (不在/需要/リスク)       │ │
│  │  traffic_realtime     │         │         ↓ SP群                     │ │
│  │  road_construction    │         │ RISK_SCORES      (Iceberg v3)      │ │
│  │  depots               │         │ ABSENCE_PATTERNS (Iceberg v3)      │ │
│  │                       │         │ DEMAND_FORECAST  (Iceberg v3)      │ │
│  │                       │         │ BUILDING_ATTRIBUTES (Iceberg v3)   │ │
│  │                       │         │ H3_COST_MATRIX   (通常テーブル)     │ │
│  ├───────────────────────┤         └──────────┬┬───────────────────────┘ │
│  │ Foreign Table (ft_*)  │                    ││                          │
│  │  ft_risk_scores       │◀───────────────────┘│ S3 Parquet (自動書出)    │
│  │  ft_kpi_daily         │  pg_lake Foreign Table                         │
│  │  ft_absence_patterns  │  (同期不要、S3 Parquet 直参照)                   │
│  │  ft_demand_forecast   │                     │                          │
│  │  ft_delivery_history  │  ※ Snowflake→Postgres は pg_lake で            │
│  │  ft_building_attributes│   同期レス。逆方向 (PG→SF) は pg_lake          │
│  │                       │   非対応のため SP による従来型 ETL               │
│  └───────────┬───────────┘                     │                          │
│              │ pgQuery (PG接続)                 │ sfQuery (SF直接接続)      │
│              │  ・ネイティブ: SELECT * FROM drivers                         │
│              │  ・Foreign:   SELECT * FROM ft_risk_scores                  │
│              │  → 業務データ全般                  │ → ルート最適化・地図レイヤ │
│              ▼                                  ▼                          │
│  ┌──────────────────────────────────────────────┐                          │
│  │   SPCS React App (Next.js + deck.gl)         │                          │
│  │                                              │                          │
│  │   pgQuery 専用 API:                            │                          │
│  │     Plan: packages, drivers, construction等   │                          │
│  │     Monitor: locations, routes, alerts等      │                          │
│  │     Review: kpi(ft_*), absence-heatmap(ft_*) │                          │
│  │                                              │                          │
│  │   デュアルパス API (?source=pg|sf):            │                          │
│  │     Plan: risk-map, building-density          │                          │
│  │       pg→ft_risk_scores/ft_building_attributes│                          │
│  │       sf→RISK_SCORES/BUILDING_ATTRIBUTES(既定)│                          │
│  │                                              │                          │
│  │   pgQuery+sfQuery 併用 API:                   │                          │
│  │     Plan: routes/generate                     │                          │
│  │       (RISK_SCORES, ABSENCE_PATTERNS,         │                          │
│  │        H3_COST_MATRIX)                        │                          │
│  │     Monitor: routes/readjust, next-trip       │                          │
│  │       (RISK_SCORES, H3_COST_MATRIX)           │                          │
│  └──────────────────────────────────────────────┘                          │
└───────────────────────────────────────────────────────────────────────────┘
```

### パイプライン 1: Postgres → Snowflake (日次 ETL)

**方向:** Postgres → Snowflake Iceberg v3
**起動:** TASK_DAILY_ETL (毎日 23:00 JST)
**実行SP:** SP_ETL_POSTGRES_SYNC

```
Postgres                                    Snowflake (Iceberg v3)
─────────                                   ──────────────────────
delivery_status ──┐                         
                  ├── psycopg2 で SELECT ──▶ DELIVERY_HISTORY
packages ─────────┘   (差分: WHERE date > MAX(DATE))
                      ・ST_MAKEPOINT(LNG,LAT) → DELIVERY_LOCATION (GEOGRAPHY)
                      ・H3_POINT_TO_CELL_STRING → H3_INDEX_R9
                      ・OBJECT_CONSTRUCT → METADATA (VARIANT)
                      ・INSERT INTO

delivery_status ──── 集計 SELECT ──────────▶ KPI_DAILY
                     (全日付再計算)            DELETE → INSERT
```

**ポイント:**
- Postgres h3 と Snowflake H3 は非互換 → H3 は Snowflake 側で再計算
- DELIVERY_HISTORY は差分取込 (MAX(DATE) 以降のみ)
- KPI_DAILY は全件洗い替え

### パイプライン 2: Snowflake ML 計算 (日次バッチ)

**方向:** Snowflake テーブル間
**起動:** TASK_DAILY_ETL の後続タスク (並列 2 系統)

```
TASK_DAILY_ETL (SP_ETL_POSTGRES_SYNC)
  │
  ├──▶ TASK_RISK_SCORES (SP_RECALC_RISK_SCORES)
  │      読み取り: ABSENCE_PATTERNS, BUILDING_ATTRIBUTES,
  │                V_WEATHER_FORECAST_LIVE, V_POI_AREA_PROFILE
  │      書き込み: RISK_SCORES
  │      処理: DELETE (当日以降) → INSERT (7日分×6時間帯×全H3セル)
  │      │
  │      └──▶ TASK_DEMAND_FORECAST (SP_REFRESH_DEMAND_FORECAST)
  │             読み取り: V_WEATHER_FORECAST_LIVE, ML Models (LightGBM×3)
  │             書き込み: DEMAND_FORECAST
  │             処理: DELETE → INSERT (7日分)
  │
  └──▶ TASK_ABSENCE_PATTERNS (SP_PREDICT_ABSENCE)
         読み取り: DELIVERY_HISTORY, BUILDING_ATTRIBUTES,
                   V_WEATHER_HISTORY, V_POI_AREA_PROFILE, ML Models (XGBoost)
         書き込み: ABSENCE_PATTERNS
         処理: TRUNCATE → INSERT (全 H3×曜日×時間帯)
```

**依存関係の理由:**
- RISK_SCORES は ABSENCE_PATTERNS を入力に使う → 同じサイクルの更新は翌日反映
- DEMAND_FORECAST は RISK_SCORES 不要だが、RISK_SCORES 完了後に実行 (リソース分散)

### パイプライン 3: Snowflake → Postgres (自動反映)

**方向:** Snowflake Iceberg v3 → S3 Parquet → pg_lake Foreign Table
**起動:** 自動 (Iceberg テーブルへの書き込みと同時)

```
Snowflake Iceberg v3 テーブル     S3 (自動)              Postgres
───────────────────────────       ──────────             ────────
RISK_SCORES         ──write──▶   S3 Parquet  ◀──read── ft_risk_scores
KPI_DAILY           ──write──▶   S3 Parquet  ◀──read── ft_kpi_daily
ABSENCE_PATTERNS    ──write──▶   S3 Parquet  ◀──read── ft_absence_patterns
DEMAND_FORECAST     ──write──▶   S3 Parquet  ◀──read── ft_demand_forecast
DELIVERY_HISTORY    ──write──▶   S3 Parquet  ◀──read── ft_delivery_history
BUILDING_ATTRIBUTES ──write──▶   S3 Parquet  ◀──read── ft_building_attributes
```

**ポイント:**
- **同期ジョブ不要** — Iceberg テーブルが更新されると S3 Parquet が自動更新
- Foreign Table は S3 を直接参照するため、SP 実行完了 = アプリに即反映
- スキーマ変更も Foreign Table が自動推論 (カラム定義なし `()`)

### パイプライン 4: Marketplace → Snowflake (外部データ)

**方向:** Snowflake Marketplace → Views (リアルタイム参照)

```
ZTS_WEATHERSOURCE (Marketplace)
  ├──▶ V_WEATHER_FORECAST_LIVE  → SP_RECALC_RISK_SCORES / SP_REFRESH_DEMAND_FORECAST / React API
  └──▶ V_WEATHER_HISTORY        → SP_PREDICT_ABSENCE

ZTS_SAFEGRAPH (Marketplace)
  └──▶ V_POI_AREA_PROFILE       → SP_RECALC_RISK_SCORES / SP_PREDICT_ABSENCE
```

### Task Chain タイムライン (日次)

```
23:00 JST ─── TASK_DAILY_ETL (SP_ETL_POSTGRES_SYNC)
              │  Postgres → DELIVERY_HISTORY + KPI_DAILY
              │  所要時間: ~30秒
              │
              ├── TASK_RISK_SCORES (SP_RECALC_RISK_SCORES)
              │     ML + 統計 → RISK_SCORES
              │     所要時間: ~1分
              │     │
              │     └── TASK_DEMAND_FORECAST (SP_REFRESH_DEMAND_FORECAST)
              │           LightGBM 推論 → DEMAND_FORECAST
              │           所要時間: ~30秒
              │
              └── TASK_ABSENCE_PATTERNS (SP_PREDICT_ABSENCE)
                    XGBoost 推論 → ABSENCE_PATTERNS
                    所要時間: ~2分

              ↓ 全タスク完了 (約3分)
              S3 Parquet 自動更新
              ↓
              Postgres ft_* から即参照可能
              ↓
翌朝         所長アプリに最新 ML 結果が反映済み
```

---

## 7. Postgres 環境構成

### 接続情報

→ **[docs/deployment.md](deployment.md)** を参照。

### 有効な拡張

pg_lake 3.2, pg_lake_copy 3.2, pg_lake_engine 3.2, pg_lake_iceberg 3.2, pg_lake_table 3.2, snowflake_auth 1.0, h3, h3_postgis, postgis

### ネイティブテーブル (操業データ)

| テーブル | 用途 |
|---------|------|
| packages | 荷物マスタ（日次ロード） |
| drivers | ドライバーマスタ |
| driver_locations | GPS リアルタイム (UPSERT) |
| driver_locations_history | GPS 履歴 |
| delivery_status | 配達状況リアルタイム |
| routes | ルート・積み順 |
| traffic_realtime | 渋滞リアルタイム |
| road_construction | 工事・規制 |
| depots | 配送所マスタ |

### Foreign Tables (pg_lake — Iceberg v3 データ参照)

| Foreign Table | S3 パス | 行数 | 元テーブル |
|---------------|---------|------|-----------|
| ft_risk_scores | `s3://ryoshida-demo/pg_lake/managed/risk_scores.TnfolGZJ/data/**/*.parquet` | 15,574 | RISK_SCORES |
| ft_kpi_daily | `s3://ryoshida-demo/pg_lake/managed/kpi_daily.at6hZXAP/data/**/*.parquet` | 34 | KPI_DAILY |
| ft_absence_patterns | `s3://ryoshida-demo/pg_lake/managed/absence_patterns.RlFmqfQm/data/**/*.parquet` | 1,567 | ABSENCE_PATTERNS |
| ft_demand_forecast | `s3://ryoshida-demo/pg_lake/managed/demand_forecast.QgRjQeBB/data/**/*.parquet` | 7 | DEMAND_FORECAST |
| ft_delivery_history | `s3://ryoshida-demo/pg_lake/managed/delivery_history.A4hQjZs7/data/**/*.parquet` | 15,927 | DELIVERY_HISTORY |
| ft_building_attributes | `s3://ryoshida-demo/pg_lake/managed/building_attributes.cpQtMdWH/data/**/*.parquet` | 10,569 | BUILDING_ATTRIBUTES |

### Foreign Table 作成方法

```sql
CALL LASTMILE_DB.ANALYTICS.SP_SETUP_FOREIGN_TABLES();
```

内部で以下を実行:
```sql
CREATE FOREIGN TABLE ft_risk_scores ()
  SERVER pg_lake
  OPTIONS (path 's3://ryoshida-demo/pg_lake/managed/risk_scores.TnfolGZJ/data/**/*.parquet');
```

pg_lake Foreign Table はスキーマを自動推論するため、カラム定義は空 `()` で作成可能。

---

## 8. API Route — テーブルマッピング

### Postgres 経由 (pg_lake Foreign Table)

| Route | テーブル | 備考 |
|-------|---------|------|
| `/api/plan/risk-map?source=pg` | ft_risk_scores | デュアルパス対応。RISK_FACTORS を個別カラム (weather_risk, absence_risk, building_risk, poi_risk) から JSON 再構築 |
| `/api/plan/building-density?source=pg` | ft_building_attributes + ft_delivery_history | デュアルパス対応。H3 集約で建物密度算出 |
| `/api/review/kpi` | ft_kpi_daily | delivery_status からの計算 fallback あり |
| `/api/review/absence-heatmap` | ft_absence_patterns | fallback データ生成あり |
| `/api/review/demand-forecast` | ft_demand_forecast | fallback データ生成あり |

### Postgres 直接 (ネイティブテーブル)

| Route | テーブル |
|-------|---------|
| `/api/plan/packages` | packages, drivers |
| `/api/plan/drivers` | drivers |
| `/api/plan/routes` | routes |
| `/api/monitor/progress` | delivery_status |
| `/api/monitor/driver-locations` | driver_locations |
| `/api/monitor/traffic` | traffic_realtime |
| `/api/monitor/construction` | road_construction |

### Snowflake 直接

| Route | テーブル | 理由 |
|-------|---------|------|
| `/api/plan/risk-map?source=sf` | ANALYTICS.RISK_SCORES | デュアルパス対応（sf がデフォルト）。パフォーマンス比較用 |
| `/api/plan/building-density?source=sf` | ANALYTICS.BUILDING_ATTRIBUTES + DELIVERY_HISTORY | デュアルパス対応（sf がデフォルト）。パフォーマンス比較用 |
| `/api/plan/weather` | V_WEATHER_FORECAST_LIVE | Cortex LLM による天気予報生成 |
| `/api/admin/snowflake-query` | 任意 | 管理画面用 |
| `/api/admin/snowflake-tables` | INFORMATION_SCHEMA | 管理画面用 |

### カラム名マッピング

Postgres は小文字カラム名 (`h3_index`, `risk_score`) を返すが、フロントエンドの TypeScript 型は大文字 (`H3_INDEX`, `RISK_SCORE`) を期待する。各 API Route で明示的にマッピングを行う。

```typescript
const mapped: RiskScore[] = rows.map((r) => ({
  H3_INDEX: r.h3_index,
  RISK_SCORE: r.risk_score,
  RISK_FACTORS: {
    weather: r.weather_risk,
    absence: r.absence_risk,
    building: r.building_risk,
    poi: r.poi_risk,
  },
}));
```

---

## 9. ML パイプライン

### モデル一覧

| モデル | 目的 | 手法 | 出力先 |
|--------|------|------|--------|
| 不在予測 | H3セル×曜日×時間帯の不在確率を予測 | XGBoost (Snowpark ML) | ABSENCE_PATTERNS (Iceberg v3) |
| リスクスコアリング | 配送リスクの総合スコアを算出 | LightGBM / SP統計モデル | RISK_SCORES (Iceberg v3) |
| 荷量需要予測 | 翌週の拠点別荷量を予測 | Cortex ML FORECAST | DEMAND_FORECAST (Iceberg v3) |

### パイプラインフロー

```
Snowflake Notebook (モデル開発)
  → Model Registry (バージョン管理)
  → Task Chain (日次バッチ)
    → SP が Managed Iceberg v3 テーブルに直接書き込み
    → S3 Parquet 自動更新
    → pg_lake Foreign Table から即座に最新データ参照可能
```

### リスクスコアリング（H3 Resolution 9 — セル辺長 約174m）

```
配送リスクスコア = f(
    過去の不在率,          -- H3セル別・曜日別・時間帯別 (XGBoost 特徴量加重)
    気象予報,             -- 降水確率・風速・気温
    道路工事・規制,        -- 翌日の工事予定
    POI リスク            -- 建物タイプ・EV有無・宅配BOX有無
)
```

---

## 10. デモシナリオ（20分 3幕構成）

### Act 1: 明日の計画を立てる（7分）

> **状況設定:** 明日3/10は午後から雨予報。エリアCで道路工事あり。再配達が15件。

| ステップ | デモ操作 | 見せるポイント |
|---------|---------|---------------|
| 1 | 所長アプリを開く → 明日の荷物487件が自動表示 | React(SPCS) + Postgres のリアルタイム連携 |
| 2 | H3 リスクマップを確認 → エリアCが赤い | **pg_lake Foreign Table** 経由で ML スコアを地図に反映 |
| 3 | リスクの高いセルをクリック → 要因分解表示 | ML の説明可能性 (4因子: 天気/不在/建物/POI) |
| 4 | 天気予報を確認 → 午後から雨の詳細 | **Cortex LLM** による自然言語天気予報 |
| 5 | ルート自動生成 → 12台分のルート＋積み順が即表示 | pgrouting + pg_cron |

### Act 2: 当日の現場を見守る（8分）

> **状況設定:** 配送開始3時間後。鈴木ドライバーが遅延。エリアBで突発渋滞。

| ステップ | デモ操作 | 見せるポイント |
|---------|---------|---------------|
| 1 | 全ドライバーの位置がリアルタイム表示 | Postgres ネイティブテーブル + deck.gl |
| 2 | 進捗バーで全体64%、鈴木が遅延中と一目でわかる | 所長の判断を即時支援 |
| 3 | エリアBに渋滞 H3 オーバーレイが出現 | リアルタイム外部データ連携 |
| 4 | 地図上の交差点をクリック → 事故シミュレーション | h3_grid_disk + PostGIS + pgrouting |

### Act 3: 振り返りで明日をもっと良くする（6分）

> **状況設定:** 配送終了。本日の実績を確認し、翌日に活かす。

| ステップ | デモ操作 | 見せるポイント |
|---------|---------|---------------|
| 1 | KPI サマリ表示: 完了率94.3%、不在率12.1% | **pg_lake Foreign Table** 経由で KPI 即表示 |
| 2 | H3 不在ヒートマップ → エリアBの14-16時が真っ赤 | 空間×時間の分析 (pg_lake Foreign Table) |
| 3 | 需要予測グラフ → 翌週の荷量トレンド | Cortex ML FORECAST の可視化 |
| 4 | **画面切替: Streamlit in Snowflake** → ML 精度・KPI トレンドを表示 | 「分析は Snowflake 本体で」 |
| 5 | アーキテクチャ図を表示 →「全て Snowflake 上で完結」 | Why Snowflake |

---

## 11. 進行中の作業

### Iceberg v3 統合 (完了)

全 ANALYTICS テーブルを Managed Iceberg v3 に統合済み。旧 ICE_* 二重管理は廃止。

- RISK_SCORES, KPI_DAILY, ABSENCE_PATTERNS, DEMAND_FORECAST, DELIVERY_HISTORY, BUILDING_ATTRIBUTES → 全て Iceberg v3
- v3 機能活用: VARIANT (RISK_FACTORS, METADATA, BUILDING_DETAILS), GEOGRAPHY (DELIVERY_LOCATION, CENTROID)
- SP が直接 Iceberg テーブルに書き込み → 同期タスク (旧 TASK_SYNC_ICEBERG) 不要
- Foreign Table を 4 → 6 テーブルに拡張 (ft_delivery_history, ft_building_attributes 追加)

### 残タスク

| タスク | 優先度 | 備考 |
|--------|--------|------|
| ABSENCE_PREDICTOR の WAREHOUSE target_platform 再登録 | 中 | 元の学習データが必要 |
| Postgres テーブル設計レビュー | - | 別エージェントで対応中 |
| Streamlit ダッシュボード構築 | 低 | Phase 8 |
| pgrouting 道路ネットワーク構築 | 低 | Phase 4 (pgaudit bug によりブロック中) |

---

## 12. Snowflake 訴求ポイント

### pg_lake だからこそ — Snowflake Postgres の真価

| ポイント | 詳細 |
|---------|------|
| **Foreign Table による COPY レス参照** | `CREATE FOREIGN TABLE ... SERVER pg_lake OPTIONS (path 's3://...')` で Snowflake Managed Iceberg v3 の S3 Parquet を直接参照。データコピー不要、同期ジョブ不要。SP が Iceberg テーブルに書き込むと即座にアプリに反映される |
| **OLTP と分析データの透過的統合** | アプリから見ると `SELECT * FROM drivers` (ネイティブ) も `SELECT * FROM ft_risk_scores` (Foreign Table) も同じ Postgres クエリ。接続先を切り替える必要がない。**1つの Postgres コネクションで操業データと ML 出力の両方にアクセスできる** |
| **スキーマ自動推論** | pg_lake Foreign Table は Parquet のスキーマを自動推論するため、カラム定義なしの `CREATE FOREIGN TABLE ft_name () SERVER pg_lake OPTIONS (...)` で作成可能。Iceberg 側のスキーマ変更にも追従しやすい |
| **pg_lake + PostGIS + H3 の組み合わせ** | Foreign Table で取得した ML スコアに対して、同一クエリ内で PostGIS 空間演算や H3 メッシュ変換を適用できる。他の DWH 連携方式（FDW、API 経由等）では実現困難な、**分析データと空間演算の同居** |
| **Snowflake Postgres エコシステム** | pg_lake だけでなく h3, h3_postgis, postgis, pgrouting が同一インスタンスで利用可能。Snowflake 本体の分析力と Postgres の GIS/ルーティング機能を **pg_lake が橋渡し** する |

### Iceberg v3 だからこそ — オープンレイクハウスの進化

本デモの Managed Iceberg Tables は全て **Iceberg v3** (2026年3月 Preview) で作成済み。

| v3 機能 | 本デモでの活用 | 意義 |
|---------|--------------|------|
| **VARIANT 型サポート** | RISK_SCORES の `RISK_FACTORS` カラムに VARIANT を使用。4因子 (weather, absence, building, poi) を構造化しつつ柔軟に拡張可能。DELIVERY_HISTORY の `METADATA`、BUILDING_ATTRIBUTES の `BUILDING_DETAILS` にも活用 | v2 では Iceberg に VARIANT を格納できなかった。v3 により Snowflake ネイティブの半構造化データをそのまま Iceberg に書き出せる |
| **GEOGRAPHY 型サポート** | DELIVERY_HISTORY の `DELIVERY_LOCATION`、BUILDING_ATTRIBUTES の `CENTROID` に GEOGRAPHY 型を使用。配送先の空間情報を Iceberg に直接格納 | v2 では空間データを Iceberg に格納するには座標を分離して数値カラムで持つ必要があった。v3 により **空間分析に最適化された Parquet** が生成され、pg_lake Foreign Table 経由での空間クエリ性能が向上 |
| **Deletion Vector** | RISK_SCORES のような日次更新テーブルで、書き込み性能が向上。行単位の論理削除をビットマップで管理し、Parquet ファイルの書き換えを最小化 | v2 の position delete と比較して、**差分更新のオーバーヘッドが大幅に削減**。日次バッチの Task Chain 実行時間短縮に寄与 |
| **Row Lineage** | 各行に `_row_id` と `_last_updated_sequence_number` が暗黙的に付与。CDC ワークフローや監査に活用可能 | 「どの行がいつ変更されたか」をフォーマットレベルで追跡可能。将来的に **Streams on Iceberg v3** で CDC が実現できる |
| **Default Values** | 新規カラム追加時のデフォルト値設定。ML モデル改善でリスク因子を追加する際に、既存 Parquet の書き換えが不要 | スキーマ進化時の **後方互換性を保ちながら柔軟にカラム追加** |

### Iceberg v3 + pg_lake の組み合わせが生む価値

```
従来 (v2 + COPY方式):
  Snowflake ANALYTICS → Iceberg v2 (VARIANT/GEOGRAPHY 不可)
    → S3 Parquet (数値・文字列カラムのみ)
    → COPY FROM parquet → Postgres テーブル (スナップショット)
    → 日次同期ジョブの運用コスト

現在 (v3 + Foreign Table方式):
  Snowflake → Iceberg v3 (VARIANT + GEOGRAPHY ネイティブ)
    → S3 Parquet (リッチな型がそのまま格納)
    → pg_lake Foreign Table (S3 直参照、同期不要)
    → アプリから即時参照、運用コストほぼゼロ
```

| 観点 | v2 + COPY | v3 + Foreign Table |
|------|-----------|-------------------|
| 半構造化データ | Iceberg に格納不可 → カラム分離が必要 | VARIANT でそのまま格納 |
| 空間データ | 座標を lat/lng カラムに分離 | GEOGRAPHY でネイティブ格納 |
| データ鮮度 | 日次 COPY (分〜時間の遅延) | Iceberg 更新と同時に参照可能 |
| 運用コスト | COPY SP + Task Chain + 監視 | Foreign Table 作成のみ |
| 書き込み性能 | position delete (重い) | deletion vector (軽い) |
| スキーマ進化 | COPY 先テーブルも手動変更 | Foreign Table がスキーマ自動推論 |

### その他の訴求ポイント

| ポイント | 詳細 |
|---------|------|
| **H3 のデュアル活用** | Snowflake H3 関数（バッチ分析）と Postgres h3_postgis（リアルタイム空間演算）の使い分け |
| **ML の即戦力感** | Cortex ML で需要予測が SQL 一発 + Notebook でカスタムモデル開発 |
| **SPCS の柔軟性** | Next.js をコンテナデプロイ。業務アプリも Snowflake 内で完結 |
| **役割に応じた UI 選択** | 所長には React 業務アプリ、データチームには Streamlit 分析ダッシュボード |

---

## 13. 参考リソース

- [Snowflake H3 関数](https://docs.snowflake.com/en/sql-reference/functions/h3_coverage)
- [Snowflake Postgres 拡張機能一覧](https://docs.snowflake.com/en/user-guide/snowflake-postgres/postgres-extensions)
- [Snowflake Cortex ML](https://docs.snowflake.com/en/guides-overview-ml-powered-functions)
- [SPCS ドキュメント](https://docs.snowflake.com/en/developer-guide/snowpark-container-services/overview)
- [pgrouting ドキュメント](https://pgrouting.org/)
- [H3 公式サイト（Uber）](https://h3geo.org/)
- [deck.gl ドキュメント](https://deck.gl/)
