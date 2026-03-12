# ML パイプライン — 現状構成とスケーリング推奨

## 現状構成 (デモ環境)

### インフラ

| リソース | 現状 | 備考 |
|---------|------|------|
| Snowflake Warehouse | RYOSHIDA_WH (Medium, Standard) | 学習・推論・Cortex ML 全兼用 |
| Postgres | lastmile_postgres (STANDARD_M, 100GB) | 配送オペレーション用 |
| S3 | ryoshida-demo/pg_lake/ | pg_lake Iceberg ストレージ |
| Python 環境 | ローカル venv (Python 3.11) | 学習スクリプト実行 |

### モデル一覧

| モデル | フレームワーク | 登録先 | 学習データ量 | 精度 |
|--------|---------------|--------|-------------|------|
| ABSENCE_PREDICTOR V1 | XGBoost (分類) | Model Registry | 1,048,841 rows | AUC 0.759 |
| RISK_SCORER V1 | LightGBM (回帰) | Model Registry | 930,072 rows | MAE 0.17 |
| DEMAND_FORECAST_MODEL | Cortex ML FORECAST | ML スキーマ | 31 rows (日次) | — |
| ABSENCE_ANOMALY_MODEL | Cortex ML ANOMALY_DETECTION | ML スキーマ | 24 rows (日次) | — |

### バッチ Task

| Task | スケジュール | 処理内容 |
|------|------------|---------|
| TASK_DAILY_FORECAST | 05:00 JST | 需要予測モデル再学習 + 7日分予測書き込み |
| TASK_DAILY_ANOMALY | 22:30 JST | 直近3日の不在率異常検知 |

### データフロー

```
Postgres (配送オペレーション)
  ↓ pg_lake Iceberg
S3 (Parquet)
  ↓ Snowflake External Table / Catalog Sync
Snowflake ANALYTICS (集計テーブル)
  ↓
ML 学習 (Model Registry / Cortex ML)
  ↓
バッチ推論 Task → ANALYTICS テーブル書き戻し
  ↓
アプリ参照
```

---

## スケーリング推奨

### データ量の目安

| 段階 | 配送件数/日 | DELIVERY_HISTORY (月) | RISK_SCORES (月) | 推奨対応 |
|------|-----------|---------------------|-----------------|---------|
| デモ | ~500 | ~15K | ~15K | 現状のまま |
| 小規模 | ~5,000 | ~150K | ~1.5M | Warehouse サイズアップ |
| 中規模 | ~50,000 | ~1.5M | ~15M | 専用 Warehouse 分離 + Snowpark Optimized |
| 大規模 | ~500,000 | ~15M | ~150M | 全面的な再設計 |

---

### 1. Warehouse 分離

現状は 1 つの Medium Warehouse で全処理を兼用しているが、規模拡大時は用途別に分離する。

```sql
-- 推論用 (低レイテンシ、常時稼働)
CREATE WAREHOUSE IF NOT EXISTS LASTMILE_INFERENCE_WH
    WAREHOUSE_SIZE = 'SMALL'
    AUTO_SUSPEND = 60
    AUTO_RESUME = TRUE;

-- ML 学習用 (高メモリ、バッチ実行)
CREATE WAREHOUSE IF NOT EXISTS LASTMILE_ML_TRAIN_WH
    WAREHOUSE_SIZE = 'MEDIUM'
    WAREHOUSE_TYPE = 'SNOWPARK-OPTIMIZED'
    AUTO_SUSPEND = 120
    AUTO_RESUME = TRUE;

-- Cortex ML 用 (FORECAST/ANOMALY_DETECTION)
CREATE WAREHOUSE IF NOT EXISTS LASTMILE_CORTEX_WH
    WAREHOUSE_SIZE = 'MEDIUM'
    AUTO_SUSPEND = 120
    AUTO_RESUME = TRUE;

-- Task を専用 Warehouse に変更
ALTER TASK LASTMILE_DB.ML.TASK_DAILY_FORECAST SET WAREHOUSE = LASTMILE_CORTEX_WH;
ALTER TASK LASTMILE_DB.ML.TASK_DAILY_ANOMALY SET WAREHOUSE = LASTMILE_CORTEX_WH;
```

**目安:**
- 5,000件/日 → Small で十分
- 50,000件/日 → Medium + Snowpark Optimized (ML 学習)
- 500,000件/日 → Large + Multi-cluster (推論)

### 2. モデル学習の改善

#### 2a. 特徴量の拡充

現状の ABSENCE_PREDICTOR は HIST_ABSENCE_RATE が支配的 (importance 93%)。精度を上げるには:

```
追加特徴量候補:
- 天気情報 (降水量、気温、天気コード)
- 配送時間帯の細分化 (午前/午後/夕方)
- 曜日 × 時間帯のクロス特徴量
- 祝日フラグ
- マンション階数 (高層 → 不在率高い傾向)
- 過去N回の配送結果 (シーケンシャル特徴量)
- 配送先までの距離 (ルート効率)
```

#### 2b. 学習パイプラインを Snowflake Notebook に移行

ローカル venv での学習はデモ向き。本番では Snowflake Notebook を推奨:

```
メリット:
- Snowpark ML のネイティブサポート (データ移動不要)
- Warehouse 上で学習 (メモリ・CPU スケール可能)
- Task からの Notebook 実行でスケジュール化
- Model Registry への直接登録
```

#### 2c. ハイパーパラメータチューニング

```python
from sklearn.model_selection import GridSearchCV

param_grid = {
    'n_estimators': [100, 200, 500],
    'max_depth': [3, 5, 7, 9],
    'learning_rate': [0.01, 0.05, 0.1],
    'min_child_weight': [1, 3, 5],
    'subsample': [0.7, 0.8, 0.9]
}
```

50K件/日以上では Snowpark Optimized Warehouse (XL) でグリッドサーチを実行。

### 3. 推論の最適化

#### 3a. target_platforms の変更

現状は `SNOWPARK_CONTAINER_SERVICES` のみ。SQL 推論を有効にする場合:

```python
mv = reg.log_model(
    model,
    model_name="ABSENCE_PREDICTOR",
    version_name="V2",
    target_platforms=["WAREHOUSE", "SNOWPARK_CONTAINER_SERVICES"],
    conda_dependencies=["xgboost"],
    ...
)
```

`WAREHOUSE` を追加すると SQL から直接推論可能:

```sql
SELECT
    H3_INDEX,
    MODEL(LASTMILE_DB.ML.ABSENCE_PREDICTOR, V2)!PREDICT(
        DAY_OF_WEEK, HOUR_OF_DAY, BUILDING_TYPE_ENC,
        HAS_ELEVATOR, HAS_DELIVERY_BOX, AVG_FLOORS,
        HIST_ABSENCE_RATE, HIST_SAMPLE_COUNT
    ):output_feature_0::FLOAT AS ABSENCE_PROBABILITY
FROM feature_table;
```

#### 3b. バッチ推論のスケジュール細分化

```sql
-- 大規模時: 1時間ごとにリスクスコア更新
CREATE OR REPLACE TASK LASTMILE_DB.ML.HOURLY_RISK_SCORING
    WAREHOUSE = LASTMILE_INFERENCE_WH
    SCHEDULE = 'USING CRON 0 * * * * Asia/Tokyo'
AS
    MERGE INTO LASTMILE_DB.ANALYTICS.RISK_SCORES t
    USING (
        SELECT h3_index, CURRENT_DATE() AS date, HOUR(CURRENT_TIMESTAMP()) AS hour,
               MODEL(LASTMILE_DB.ML.RISK_SCORER, V1)!PREDICT(...)::FLOAT AS risk_score
        FROM feature_view
    ) s
    ON t.H3_INDEX = s.h3_index AND t.DATE = s.date AND t.HOUR = s.hour
    WHEN MATCHED THEN UPDATE SET risk_score = s.risk_score
    WHEN NOT MATCHED THEN INSERT VALUES (...);
```

#### 3c. リアルタイム推論 (SPCS)

50K件/日以上で低レイテンシが必要な場合、SPCS で REST エンドポイントを構築:

```python
mv = reg.get_model("ABSENCE_PREDICTOR").version("V2")
mv.create_service(
    service_name="absence_predictor_service",
    service_compute_pool="LASTMILE_GPU_POOL",
    image_repo="LASTMILE_DB.ML.IMAGE_REPO",
    ingress_enabled=True,
    max_instances=3
)
```

### 4. Cortex ML のスケーリング

#### 4a. FORECAST — 多系列化

配送所が増えた場合、系列カラムを追加:

```sql
CREATE OR REPLACE VIEW LASTMILE_DB.ML.V_KPI_MULTI_DEPOT AS
SELECT
    DEPOT_ID AS SERIES_ID,
    DATE::TIMESTAMP_NTZ AS TS,
    TOTAL_PACKAGES::FLOAT AS TOTAL_PACKAGES
FROM LASTMILE_DB.ANALYTICS.KPI_DAILY;

CREATE OR REPLACE SNOWFLAKE.ML.FORECAST LASTMILE_DB.ML.DEMAND_FORECAST_MULTI(
    INPUT_DATA => TABLE(LASTMILE_DB.ML.V_KPI_MULTI_DEPOT),
    SERIES_COLNAME => 'SERIES_ID',
    TIMESTAMP_COLNAME => 'TS',
    TARGET_COLNAME => 'TOTAL_PACKAGES'
);
```

#### 4b. FORECAST — 外部特徴量の追加

天気・イベント情報を特徴量として組み込む:

```sql
CREATE OR REPLACE VIEW LASTMILE_DB.ML.V_KPI_WITH_FEATURES AS
SELECT
    DATE::TIMESTAMP_NTZ AS TS,
    TOTAL_PACKAGES::FLOAT AS TOTAL_PACKAGES,
    AVG_TEMPERATURE::FLOAT AS TEMPERATURE,
    TOTAL_PRECIPITATION::FLOAT AS PRECIPITATION,
    IS_HOLIDAY::BOOLEAN AS IS_HOLIDAY
FROM LASTMILE_DB.ANALYTICS.KPI_DAILY_ENRICHED;
```

#### 4c. ANOMALY_DETECTION — Warehouse 推奨

| 時系列長 | 系列数 | 推奨 Warehouse |
|---------|--------|---------------|
| < 5M rows | 1 系列 | Standard XS |
| < 5M rows | 複数系列 | Standard — サイズアップ |
| > 5M rows | any | Snowpark Optimized XS 以上 |

### 5. Postgres (pg_lake) のスケーリング

#### 5a. Iceberg テーブルの活用拡大

大量の配送履歴を Postgres → S3 → Snowflake で連携:

```sql
-- Postgres 側: 日次パーティション付き Iceberg テーブル
CREATE TABLE delivery_history_lake (
    LIKE delivery_status
) USING pg_lake_iceberg;

-- 日次バッチで INSERT
INSERT INTO delivery_history_lake
SELECT * FROM delivery_status
WHERE date = CURRENT_DATE - 1;
```

#### 5b. Postgres インスタンスのスケールアップ

| 段階 | 同時接続数 | 推奨 |
|------|----------|------|
| デモ | < 10 | STANDARD_M (現状) |
| 小規模 | 10-50 | STANDARD_L |
| 中規模 | 50-200 | STANDARD_XL + Read Replica |
| 大規模 | 200+ | HA 構成 + Read Replica 複数 |

```sql
-- HA 構成に変更
ALTER POSTGRES INSTANCE "lastmile_postgres" SET IS_HA = TRUE;
```

### 6. モデルモニタリング

#### 6a. 精度モニタリング Task

```sql
CREATE OR REPLACE TASK LASTMILE_DB.ML.TASK_MODEL_MONITORING
    WAREHOUSE = LASTMILE_INFERENCE_WH
    SCHEDULE = 'USING CRON 0 6 * * 1 Asia/Tokyo'
    COMMENT = 'Weekly model accuracy monitoring (Monday 6:00 AM JST)'
AS
    INSERT INTO LASTMILE_DB.ML.MODEL_METRICS (
        MODEL_NAME, METRIC_DATE, AUC, PRECISION_ABSENT, RECALL_ABSENT
    )
    SELECT
        'ABSENCE_PREDICTOR',
        CURRENT_DATE(),
        -- 直近7日の実績 vs 予測を比較
        ...
    FROM LASTMILE_DB.ANALYTICS.DELIVERY_HISTORY
    WHERE DATE >= DATEADD('day', -7, CURRENT_DATE());
```

#### 6b. ドリフト検知

```
推奨:
- Snowflake ML Model Monitor (利用可能な場合)
- 自前: 週次で特徴量分布の KS 検定を実行
- 閾値: AUC が 0.05 以上低下したら再学習トリガー
```

### 7. コスト最適化

| 対策 | 効果 | 実装難易度 |
|------|------|-----------|
| AUTO_SUSPEND を短く (60秒) | Warehouse 待機コスト削減 | 低 |
| Task 実行頻度の見直し | 不要な再学習を削減 | 低 |
| Snowpark Optimized は学習時のみ | メモリ単価が高いため | 中 |
| Multi-cluster は推論ピーク時のみ | 過剰プロビジョニング回避 | 中 |
| Cortex ML の evaluate=FALSE | 評価不要なら学習時間半減 | 低 |
| Iceberg で Cold Data を S3 に逃がす | Snowflake ストレージ削減 | 中 |

```sql
-- コスト確認クエリ
SELECT
    WAREHOUSE_NAME,
    SUM(CREDITS_USED) AS TOTAL_CREDITS,
    SUM(CREDITS_USED_COMPUTE) AS COMPUTE_CREDITS,
    SUM(CREDITS_USED_CLOUD_SERVICES) AS CLOUD_CREDITS
FROM SNOWFLAKE.ACCOUNT_USAGE.WAREHOUSE_METERING_HISTORY
WHERE START_TIME >= DATEADD('day', -30, CURRENT_TIMESTAMP())
GROUP BY WAREHOUSE_NAME
ORDER BY TOTAL_CREDITS DESC;
```

---

## まとめ: 段階別推奨アクション

### 小規模 (~5,000件/日)

- [ ] Warehouse を Small に変更 (コスト削減)
- [ ] target_platforms に WAREHOUSE を追加 (SQL 推論有効化)
- [ ] 特徴量に天気・祝日を追加
- [ ] 週次モデルモニタリング Task 追加

### 中規模 (~50,000件/日)

- [ ] Warehouse を用途別に分離 (推論/学習/Cortex ML)
- [ ] 学習を Snowflake Notebook + Snowpark Optimized に移行
- [ ] バッチ推論を 1 時間ごとに細分化
- [ ] FORECAST を多系列化 + 外部特徴量追加
- [ ] Postgres HA 構成に変更
- [ ] モデルドリフト検知の導入

### 大規模 (~500,000件/日)

- [ ] SPCS でリアルタイム推論エンドポイント構築
- [ ] Multi-cluster Warehouse (推論)
- [ ] Iceberg パーティション戦略の最適化
- [ ] Postgres Read Replica 複数構成
- [ ] Feature Store の導入検討
- [ ] ハイパーパラメータ自動チューニング (Optuna on SPCS)
- [ ] A/B テスト基盤の構築
