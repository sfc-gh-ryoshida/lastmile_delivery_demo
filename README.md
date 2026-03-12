# Lastmile Delivery — Snowflake pg_lake デモ

Snowflake Postgres (pg_lake) + Snowflake 本体を組み合わせたラストワンマイル配送管理アプリ。  
配送所長の「計画→実行→振り返り」を 3 画面で支援する。

## 技術スタック

| レイヤー | 技術 | バージョン / 備考 |
|---------|------|-----------------|
| **フロントエンド** | React | 19.2 |
| | Next.js (App Router) | 16.1 |
| | TypeScript | 5.x |
| | Tailwind CSS | 4.x |
| | shadcn/ui | 4.x (Radix ベース) |
| | deck.gl + react-map-gl | 9.2 / 8.1 — H3 ヘキサゴン・GPS 軌跡描画 |
| | Mapbox GL JS | 3.19 |
| | Recharts | 2.15 — KPI グラフ |
| | SWR | 2.4 — データフェッチ + キャッシュ |
| | h3-js | 4.4 — H3 インデックス操作 |
| | Lucide React | アイコン |
| **バックエンド** | Next.js API Routes | 33 エンドポイント |
| | node-postgres (pg) | 8.20 — Postgres 接続 |
| | snowflake-sdk | 2.3 — Snowflake 接続 (PAT 認証) |
| **データベース (OLTP)** | Snowflake Postgres | pg_lake 3.2 + H3 拡張 |
| | Foreign Table (ft_*) | Iceberg v3 → S3 Parquet 直参照 (ゼロ ETL) |
| **データベース (分析/ML)** | Snowflake | Iceberg v3 テーブル + 通常テーブル |
| | Task Chain | 日次バッチ (ETL → ML → 予測) |
| | Stored Procedures | Python SP (psycopg2, Snowpark ML) |
| **ML** | Snowpark ML | 不在予測・リスクスコア・需要予測 |
| | H3 空間インデックス | コスト行列・リスクマップ |
| **インフラ** | SPCS | コンテナデプロイ (Docker linux/amd64) |
| | S3 (External Volume) | Iceberg v3 Parquet ストレージ |
| **開発ツール** | Python 3.11+ | GPS シミュレータ・ML 学習 |
| | ESLint + React Compiler | 静的解析 |

## アーキテクチャ

```
┌─────────────────────────────┐     ┌─────────────────────────────┐
│  Snowflake Postgres (OLTP)  │     │  Snowflake 本体 (分析/ML)   │
│                             │     │                             │
│  depots, drivers, packages  │ ETL │  ANALYTICS: RISK_SCORES,    │
│  delivery_status, routes    │────→│    ABSENCE_PATTERNS,        │
│  driver_locations(_history) │     │    H3_COST_MATRIX,          │
│  driver_attendance          │     │    KPI_DAILY, ...           │
│  delivery_alerts            │     │                             │
│                             │     │  ML: ABSENCE_MODEL,         │
│  ft_risk_scores        ←────┼─ Iceberg v3 / S3 Parquet ──────│    RISK_WEIGHTS          │
│  ft_kpi_daily          ←────┤     │                             │
│  ft_absence_patterns   ←────┤     │                             │
│  ft_demand_forecast    ←────┤     │                             │
│  ft_delivery_history   ←────┤     │                             │
│  ft_building_attributes←────┤     │                             │
└─────────────────────────────┘     └─────────────────────────────┘
         │                                    │
         └──────── lastmile-app (Next.js) ────┘
                   デプロイ先: SPCS
```

## 前提条件

| 項目 | 要件 |
|------|------|
| Snowflake アカウント | Standard 以上 (Iceberg v3, SPCS 対応) |
| Snowflake Postgres | pg_lake 3.2 + h3 拡張有効 |
| Node.js | 20 以上 |
| Docker | SPCS デプロイ時のみ |
| Python | 3.11+ (GPSシミュレータ・ML学習時のみ) |

## プロジェクト構成

```
pg_lake/
├── lastmile-app/           Next.js アプリ (SPCS デプロイ)
│   ├── src/app/api/        API Routes (33 本)
│   ├── src/components/     React コンポーネント
│   ├── src/lib/            postgres.ts, snowflake.ts
│   ├── Dockerfile          SPCS 用
│   └── .env.example        環境変数テンプレート
│
├── setup/                  環境構築 SQL (番号順に実行)
│   ├── 01_snowflake_setup.sql
│   ├── 02_postgres_schema.sql
│   ├── 03_postgres_demo_data.sql
│   ├── 04_snowflake_demo_data.sql
│   └── 05_demo_data_road_enrichment.sql
│
├── tools/                  運用ツール
│   ├── gps_simulator.py    GPS シミュレータ (Monitor 画面用)
│   └── gen_trails.py       軌跡データ生成
│
├── notebook/               ML モデル開発 (Snowpark ML)
│   ├── train_absence_model.py
│   ├── train_risk_model.py
│   └── snowpark_session.py
│
├── docs/                   設計・仕様ドキュメント
│   ├── database-design.md  DB 設計書 (全テーブル定義)
│   ├── api-specification.md API 仕様書 (全 33 API)
│   ├── app-architecture.md アプリ設計書
│   ├── gps_simulator_design.md シミュレータ設計
│   ├── route-generation-algorithm.md ルート最適化アルゴリズム
│   ├── changelog.md        実装履歴
│   └── ...                 その他設計ドキュメント
│
├── .env.example            環境変数テンプレート (ルート)
└── README.md               ← このファイル
```

## セットアップ

### 1. 環境変数を設定

```bash
cp .env.example .env
cp lastmile-app/.env.example lastmile-app/.env.local
# 各ファイルの <your-...> を実際の値に置換
```

### 2. Snowflake 本体セットアップ

```sql
-- Snowsight または SnowSQL で実行
-- setup/01_snowflake_setup.sql  → DB / スキーマ / ウェアハウス / 権限
-- setup/04_snowflake_demo_data.sql → ANALYTICS テーブル + デモデータ
```

### 3. Postgres セットアップ

```bash
# psql で接続して順番に実行
psql -h <POSTGRES_HOST> -U snowflake_admin -d postgres \
  -f setup/02_postgres_schema.sql
psql -h <POSTGRES_HOST> -U snowflake_admin -d postgres \
  -f setup/03_postgres_demo_data.sql
psql -h <POSTGRES_HOST> -U snowflake_admin -d postgres \
  -f setup/05_demo_data_road_enrichment.sql
```

### 4. Foreign Table 作成

```sql
CALL LASTMILE_DB.ANALYTICS.SP_SETUP_FOREIGN_TABLES();
```

### 5. アプリ起動 (ローカル開発)

```bash
cd lastmile-app
npm install
npm run dev
# → http://localhost:3000
```

### 6. GPS シミュレータ (Monitor 画面のリアルタイムデモ)

```bash
cd tools
pip install psycopg2-binary
python gps_simulator.py --date 2026-03-12
```

### 7. SPCS デプロイ (本番)

→ **[docs/deployment.md](docs/deployment.md)** を参照。

## 日次タスクチェーン

毎日 23:00 JST に自動実行:

```
TASK_DAILY_ETL (SP_ETL_POSTGRES_SYNC)
├── TASK_RISK_SCORES (SP_RECALC_RISK_SCORES)
│   └── TASK_DEMAND_FORECAST (SP_REFRESH_DEMAND_FORECAST)
└── TASK_ABSENCE_PATTERNS (SP_PREDICT_ABSENCE)
```

## ドキュメント一覧

| ファイル | 内容 |
|---------|------|
| [docs/database-design.md](docs/database-design.md) | DB 設計書 (Postgres 14テーブル + Snowflake 全テーブル + ER図) |
| [docs/deployment.md](docs/deployment.md) | デプロイ情報 (SPCS URL / 接続情報 / 環境変数 / 手順) |
| [docs/api-specification.md](docs/api-specification.md) | API 仕様書 (全 33 API、Request/Response/DB書込み先) |
| [docs/app-architecture.md](docs/app-architecture.md) | アプリ設計書 (技術スタック、画面構成、コンポーネント) |
| [docs/route-generation-algorithm.md](docs/route-generation-algorithm.md) | ルート最適化アルゴリズム詳細 |
| [docs/gps_simulator_design.md](docs/gps_simulator_design.md) | GPS シミュレータ設計 |
| [docs/changelog.md](docs/changelog.md) | セッション別実装履歴 |
| [docs/logistics_demo_proposal.md](docs/logistics_demo_proposal.md) | デモ企画書 |
| [docs/pg_lake_guide.md](docs/pg_lake_guide.md) | pg_lake 技術ガイド |

## ライセンス

社内デモ用。
