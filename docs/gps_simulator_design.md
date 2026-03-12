# Lastmile Delivery Simulator 設計

## 概要

デモ用に、12台のドライバーが配送ルートに沿って移動しながら、**5つのPostgresテーブルを同時にライブ更新**するシミュレーター。
1コマンドで全データが連動し、Monitor画面のすべてのパネルがリアルタイムに動く。

### 更新テーブル

| # | テーブル | 更新方式 | Monitor画面 | 無効化 |
|---|---------|---------|------------|--------|
| 1 | `driver_locations` | UPSERT (現在位置) | 地図ドライバーアイコン | — |
| 2 | `driver_locations_history` | INSERT (軌跡) | トレイルアニメーション | — |
| 3 | `delivery_status` | UPDATE (ステータス遷移) | 進捗バー、配達状況 | `--no-status` |
| 4 | `traffic_realtime` | UPSERT (渋滞H3) | 渋滞オーバーレイ | `--no-traffic` |
| 5 | `delivery_dwell` | INSERT (滞在記録) | Dwell Time分析 | `--no-dwell` |

## 動かし方

### 前提

- Python 3.10+
- `psycopg2` (`pip install psycopg2-binary`)
- `lastmile-app/.env.local` に Postgres 接続情報

### 基本コマンド

```bash
cd /Users/ryoshida/Desktop/env/pg_lake

# デモ推奨: フルリセット + ランダム配置 + 段階投入 + 15倍速
python3 tools/gps_simulator.py --reset --start random --ramp 3,6,9,12 --speed 15

# デフォルト: 全12ドライバー、10倍速、depot出発、全テーブル連動
python3 tools/gps_simulator.py

# 高速再生
python3 tools/gps_simulator.py --speed 30 --interval 0.5

# 特定ドライバーだけ
python3 tools/gps_simulator.py --drivers DRV-001,DRV-003

# GPS位置のみ (他テーブル更新なし)
python3 tools/gps_simulator.py --no-status --no-traffic --no-dwell

# 不在率を25%に設定
python3 tools/gps_simulator.py --absence-rate 0.25
```

### パラメータ一覧

| パラメータ | デフォルト | 説明 |
|-----------|----------|------|
| `--date` | `2026-03-12` | シミュレーション対象日 (**※下記注意**) |
| `--interval` | `1` | DB更新間隔 (秒) |
| `--speed` | `10` | シミュレーション速度倍率 |
| `--start` | `depot` | 初期位置: `depot` or `random` |
| `--ramp` | なし | ドライバー段階投入: `3,6,9,12` |
| `--drivers` | 全員 | 対象ドライバー: `DRV-001,DRV-002` |
| `--reset` | off | 全テーブルリセット (位置/ステータス/dwell/traffic/history) |
| `--absence-rate` | `0.12` | 各配達先での不在確率 |
| `--no-status` | off | delivery_status更新を無効化 |
| `--no-traffic` | off | traffic_realtime更新を無効化 |
| `--no-dwell` | off | delivery_dwell記録を無効化 |

### `--date` と日付依存について

シミュレータは起動時に `packages` + `delivery_status` テーブルから **指定日付のルートデータを読み込む**。
そのため、**データが存在する日付でないと動かない** (`No routes found` で終了する)。

```sql
-- どの日付にデータがあるか確認
SELECT date, COUNT(*) AS packages FROM packages GROUP BY date ORDER BY date;
```

| ケース | 動作 |
|--------|------|
| `--date 2026-03-12` (デフォルト) | ルートデータあり → 正常動作 |
| `--date 2026-03-13` (データなし) | `No routes found for 2026-03-13` で終了 |

#### 別の日付で動かす手順

1. **管理画面 (Admin) でデモデータ生成** → 対象日付の `packages` + `delivery_status` が作られる
2. **シミュレータを同じ日付で起動**

```bash
# 例: 管理画面で 2026-03-15 のデモデータを生成した後
python3 tools/gps_simulator.py --date 2026-03-15 --reset --speed 15
```

### 画面の見方

```
============================================================================
 Delivery Simulator  Date: 2026-03-12  Speed: 15.0x  Tick: 42  Elapsed: 1m05s
 Drivers: 6 active / 6 wait / 0 done    28 delivered  4 absent  460 remaining  [6%]
 [status+traffic+dwell]  absence=12%  Traffic: 3 congested cells
----------------------------------------------------------------------------
 DRV-001    走行  ██░░░░░░░░░░   7%  6/41 x1    32km/h  (35.6401,139.7953)
 DRV-002    配達  █░░░░░░░░░░░   4%  4/41         stop  (35.6533,139.7896)
 DRV-003    走行  █░░░░░░░░░░░   4%  3/41 x1    28km/h  (35.6462,139.8021)
 ...
 DRV-010     待機  ░░░░░░░░░░░░   0%  0/41         stop  (35.6548,139.8073)
============================================================================
 Updates every 1.0s  |  Ctrl+C to stop
```

| 表示 | 意味 |
|------|------|
| **走行** (水色) | 次の配達先へ移動中 |
| **配達** (黄色) | 配達先に到着、荷物渡し中 |
| **帰還** (青) | 全配達完了、depotへ戻り中 |
| **待機** (灰色) | ramp待ち |
| **完了** (緑) | depotに帰還済み |
| `x1` (赤) | 不在件数 |
| `Traffic: N congested cells` | 渋滞レベル2以上のH3セル数 |

### --reset の対象

| テーブル | リセット内容 |
|---------|------------|
| `driver_locations` | 初期位置 (depot or random) に更新 |
| `delivery_status` | 全ステータスを `pending` に、completed_at/is_absent/attempt_countクリア |
| `delivery_dwell` | 対象日・対象ドライバーのレコード削除 |
| `traffic_realtime` | 直近2時間のレコード削除 |
| `driver_locations_history` | 直近1時間のレコード削除 |

### デモシナリオ例

**シナリオ1: 朝の出発 (段階的)**
```bash
python3 tools/gps_simulator.py --reset --start depot --ramp 3,6,9,12 --speed 15
```

**シナリオ2: 途中経過 (ランダム散布)**
```bash
python3 tools/gps_simulator.py --start random --speed 10
```

**シナリオ3: 不在多発シナリオ**
```bash
python3 tools/gps_simulator.py --reset --absence-rate 0.30 --speed 20
```

### 確認用SQL

```sql
-- 現在位置
SELECT * FROM driver_locations ORDER BY driver_id;

-- 配達進捗
SELECT status, count(*) FROM delivery_status WHERE date = '2026-03-12' GROUP BY status ORDER BY status;

-- 渋滞状況
SELECT h3_index::text, congestion_level, speed_ratio FROM traffic_realtime WHERE datetime >= NOW() - INTERVAL '2 hours' ORDER BY congestion_level DESC;

-- 滞在記録
SELECT driver_id, count(*), avg(dwell_seconds)::int avg_sec FROM delivery_dwell WHERE date = '2026-03-12' GROUP BY driver_id ORDER BY driver_id;

-- 軌跡数
SELECT driver_id, count(*) FROM driver_locations_history WHERE recorded_at > NOW() - INTERVAL '1 hour' GROUP BY driver_id ORDER BY driver_id;
```

### トラブルシューティング

| 症状 | 対処 |
|------|------|
| `No routes found` | `--date` の日付にルートデータが存在するか確認 |
| `connection refused` | `.env.local` の POSTGRES_HOST/USER/PASSWORD を確認 |
| 動きが遅い | `--speed 20` 以上にするか `--interval 0.5` にする |
| 画面が崩れる | ターミナル幅を76文字以上にする |
| 渋滞が出ない | ドライバーが3人以上同一H3に集まるシーンが必要。`--start depot` で全員同じ場所から出発すると序盤に出やすい |

---

## 内部ロジック

### 移動ロジック
- 配送先間: 直線補間 + ランダムノイズ (±0.00012°)
- 移動速度: 20-40 km/h
- 到着判定: 距離 < 30m
- 滞在時間: 5-20秒 (デモ向けに短縮)
- ルート完了後: depotに帰還

### ステータス遷移
```
pending/assigned → (移動開始) → in_transit → (到着+滞在完了) → delivered (88%) or absent (12%)
```

### 渋滞ロジック
- 5tickごとにドライバー位置のH3セルを集計
- 同一H3に2台以上 → congestion_level UP + ring-1隣接セルに伝搬
- 12tick以上ドライバーがいなくなった → 渋滞解消 (level 0)
- PK: (h3_index, datetime) — 時間帯別 (1時間粒度)

### 滞在記録ロジック
- 配達完了 or 不在判定時に `delivery_dwell` にINSERT
- location_type: apartment (50%) / office (30%) / house (20%)
- floor: apartment 1-15F, office 1-25F, house 1F
- has_elevator: 5F以上なら90%, それ以外30%
- dwell_seconds: シミュレーション上の滞在時間 (5-20秒)

### ファイル
- `tools/gps_simulator.py` — メインスクリプト
