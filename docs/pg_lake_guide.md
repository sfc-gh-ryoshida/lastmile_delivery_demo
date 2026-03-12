# pg_lake セットアップ & 使い方ガイド

Snowflake Postgres の pg_lake 拡張を使って、PostgreSQL から S3 上の Iceberg テーブルを読み書きするためのガイド。

---

## アーキテクチャ

```
┌─────────────────┐    AssumeRole    ┌───────────────┐
│ Snowflake       │ ──────────────→  │ AWS IAM Role  │
│ (Storage Int.)  │  ExternalId      └───────┬───────┘
└────────┬────────┘                          │
         │ 認証情報                            │ S3 アクセス許可
         ▼                                   ▼
┌─────────────────┐    S3 Read/Write  ┌──────────────┐
│ Snowflake       │ ◄──────────────→  │ S3 Bucket    │
│ Postgres        │   (Iceberg/       │ (Parquet +   │
│ (pg_lake ext.)  │    Parquet)       │  metadata)   │
└─────────────────┘                   └──────┬───────┘
                                             │ External Volume
                                             ▼
                                     ┌──────────────┐
                                     │ Snowflake 本体│
                                     │ (Iceberg     │
                                     │  テーブル参照) │
                                     └──────────────┘
```

---

## 1. AWS 側の準備

### 1-1. S3 バケット作成

- Snowflake と **同一リージョン** にすること（例: us-west-2）
- パブリックアクセスブロックは全て ON で OK（IAM 経由のアクセスには影響しない）
- pg_lake 用のフォルダ（プレフィックス）を作成（例: `pg_lake/`）

### 1-2. IAM ロール作成（または既存ロール流用）

**最大セッション時間を 12 時間に設定すること**（デフォルト 1h では認証が切れる）。
Storage Integration 作成の **前** に設定するのが望ましい。

### 1-3. IAM Permission Policy

S3 バケットへのアクセス権限を付与する。

必要な Action:
- オブジェクト操作: `s3:PutObject`, `s3:GetObject`, `s3:GetObjectVersion`, `s3:DeleteObject`, `s3:DeleteObjectVersion`
- バケット操作: `s3:ListBucket`, `s3:GetBucketLocation`

> **注意**: JSON で同一オブジェクト内に `"Resource"` キーを 2 つ書くと後者で上書きされる。配列構文 `"Resource": ["arn:...", "arn:..."]` を使うこと。

### 1-4. IAM Trust Policy（後で更新する）

Storage Integration 作成後に得られる `STORAGE_AWS_IAM_USER_ARN` と `STORAGE_AWS_EXTERNAL_ID` を設定する。
この時点ではプレースホルダーでも可。

---

## 2. Snowflake 側の準備

### 2-1. Storage Integration 作成

```sql
CREATE OR REPLACE STORAGE INTEGRATION my_pg_lake_integration
    TYPE = POSTGRES_EXTERNAL_STORAGE
    ENABLED = TRUE
    STORAGE_PROVIDER = 'S3'
    STORAGE_AWS_ROLE_ARN = 'arn:aws:iam::ACCOUNT_ID:role/ROLE_NAME'
    STORAGE_ALLOWED_LOCATIONS = ('s3://YOUR-BUCKET/pg_lake/');
```

> **TYPE = POSTGRES_EXTERNAL_STORAGE** が pg_lake 専用。通常の `EXTERNAL_STAGE` とは異なる。

### 2-2. Integration の情報を取得

```sql
DESC STORAGE INTEGRATION my_pg_lake_integration;
```

以下の 2 つの値を控える：
- `STORAGE_AWS_IAM_USER_ARN` — Snowflake 側の IAM ユーザー ARN
- `STORAGE_AWS_EXTERNAL_ID` — AssumeRole 用の外部 ID

> **注意**: 通常の Snowflake Integration は `role/` だが、Postgres 用は **`user/snowflake-postgres-integration-management`** になる。Trust Policy の Principal を間違えないこと。

### 2-3. IAM Trust Policy を更新

AWS コンソールでロールの Trust Policy を更新する：

DESC STORAGE INTEGRATION で取得した `STORAGE_AWS_IAM_USER_ARN` を Principal に、`STORAGE_AWS_EXTERNAL_ID` を Condition に設定する。

> 複数の Integration がある場合は Principal と ExternalId を配列にする。

### 2-4. Postgres インスタンスに Storage Integration をアタッチ

```sql
ALTER POSTGRES INSTANCE "my_instance" SET STORAGE_INTEGRATION = my_pg_lake_integration;
```

確認:
```sql
DESCRIBE POSTGRES INSTANCE "my_instance";
-- storage_integration 行に Integration 名が表示されること
```

---

## 3. Postgres 側のセットアップ

### 3-1. pg_lake 拡張インストール

```sql
CREATE EXTENSION pg_lake CASCADE;
```

CASCADE で以下の依存拡張が自動インストールされる:
- `pg_extension_base`, `pg_map`, `btree_gist`
- `pg_lake_engine`, `pg_lake_table`, `pg_lake_iceberg`, `pg_lake_copy`
- `snowflake_auth`

### 3-2. デフォルトロケーションの設定

```sql
ALTER DATABASE postgres SET pg_lake_iceberg.default_location_prefix = 's3://YOUR-BUCKET/pg_lake';
```

> 末尾スラッシュなし。テーブルは `s3://YOUR-BUCKET/pg_lake/frompg/tables/DB/SCHEMA/TABLE/` 配下に自動配置される。

---

## 4. トラブルシューティング

### S3 403 Forbidden — 全設定正しいのに認証が通らない

**症状**: Trust Policy, Permission Policy, Max Session 12h, ExternalId 全て正しいのに `HTTP 403 Forbidden` が出る。

**原因**: Storage Integration をアタッチした時点で Postgres に渡された認証情報が古い/無効。

**解決策**: Storage Integration を一度外して再アタッチする。

```sql
-- Snowflake 側で実行
ALTER POSTGRES INSTANCE "my_instance" UNSET STORAGE_INTEGRATION;
ALTER POSTGRES INSTANCE "my_instance" SET STORAGE_INTEGRATION = my_pg_lake_integration;
```

再アタッチ後 10 秒程度待ってからアクセスをテスト。

### IAM 設定変更のタイミング

設定変更の推奨順序:
1. IAM ロールの最大セッション時間を 12h に設定
2. Permission Policy をアタッチ
3. Storage Integration を作成（← ここで IAM_USER_ARN と ExternalId が発行される）
4. Trust Policy を更新
5. Postgres に Storage Integration をアタッチ

順序を間違えた場合は UNSET → SET で再アタッチすればリセットできる。

---

## 5. pg_lake の使い方

### 5-1. Iceberg テーブルの作成

```sql
CREATE TABLE my_table (
    id int,
    name text,
    created_at timestamptz DEFAULT now()
) USING pg_lake_iceberg;
```

通常の Postgres テーブルと同じ構文だが、`USING pg_lake_iceberg` を付けることで S3 上に Iceberg フォーマットで保存される。

### 5-2. データ操作

```sql
INSERT INTO my_table VALUES (1, 'hello');
SELECT * FROM my_table;
UPDATE my_table SET name = 'world' WHERE id = 1;
DELETE FROM my_table WHERE id = 1;
```

通常の SQL がそのまま使える。

### 5-3. S3 ファイル操作

```sql
-- ファイル一覧
SELECT * FROM lake_file.list('s3://YOUR-BUCKET/pg_lake/**');

-- ファイル存在確認
SELECT lake_file.exists('s3://YOUR-BUCKET/pg_lake/some_file.parquet');

-- ファイルサイズ
SELECT lake_file.size('s3://YOUR-BUCKET/pg_lake/some_file.parquet');

-- ファイルのスキーマ確認（Parquet/CSV）
SELECT * FROM lake_file.preview('s3://YOUR-BUCKET/data.parquet');
```

### 5-4. Iceberg メタデータ操作

```sql
-- テーブルサイズ（バイト）
SELECT lake_iceberg.table_size('my_table'::regclass);

-- Iceberg メタデータ JSON
SELECT lake_iceberg.metadata('s3://YOUR-BUCKET/pg_lake/frompg/.../metadata/00000-xxx.metadata.json');

-- スナップショット一覧
SELECT * FROM lake_iceberg.snapshots('s3://YOUR-BUCKET/pg_lake/frompg/.../metadata/00000-xxx.metadata.json');

-- データファイル統計
SELECT * FROM lake_iceberg.data_file_stats('s3://YOUR-BUCKET/pg_lake/frompg/.../metadata/00000-xxx.metadata.json');

-- Iceberg ファイル一覧
SELECT * FROM lake_iceberg.files('s3://YOUR-BUCKET/pg_lake/frompg/.../metadata/00000-xxx.metadata.json');
```

### 5-5. Snowflake 本体からの参照（Object Store Catalog）

```sql
-- Postgres 側: カタログ生成をトリガー
SELECT lake_iceberg.trigger_object_store_catalog_generation();

-- Postgres 側: 公開済みテーブル一覧
SELECT * FROM lake_iceberg.list_object_store_tables('pg_lake_iceberg');
```

Snowflake 本体側では Iceberg テーブルとして参照可能になる。

### 5-6. COPY（ファイルの読み書き）

```sql
-- テーブルを Parquet にエクスポート
COPY my_table TO 's3://YOUR-BUCKET/pg_lake/export/my_table.parquet';

-- CSV にエクスポート
COPY my_table TO 's3://YOUR-BUCKET/pg_lake/export/my_table.csv' WITH (FORMAT csv, HEADER true);

-- 外部 Parquet ファイルを読み込み
COPY my_table FROM 's3://YOUR-BUCKET/pg_lake/import/data.parquet';
```

### 5-7. Foreign Table（読み取り専用の外部テーブル）

```sql
CREATE FOREIGN TABLE ext_data (
    id int,
    name text
) SERVER pg_lake
OPTIONS (location 's3://YOUR-BUCKET/path/to/data.parquet');

SELECT * FROM ext_data;
```

外部の Parquet/CSV ファイルを直接クエリできる。

---

## 6. S3 上のファイル構造

pg_lake Iceberg テーブルは以下のパスに自動配置される：

```
s3://BUCKET/PREFIX/frompg/tables/{database}/{schema}/{table_name}/{oid}/
├── data/
│   └── {uuid}/data_0.parquet      # 実データ
└── metadata/
    ├── 00000-xxx.metadata.json    # Iceberg メタデータ
    ├── xxx-m0.avro                # マニフェスト
    └── snap-xxx.avro              # スナップショット
```


