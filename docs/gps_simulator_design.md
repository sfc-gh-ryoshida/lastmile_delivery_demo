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

## 前提ワークフロー

シミュレーターは **計画済み（ルート確定済み）のデータに対して** 配送進捗を再現します。

```
管理画面でデモデータ生成  →  Planページでルート生成・確定  →  シミュレーター実行
         ↓                          ↓                           ↓
  packages テーブル         delivery_status に               GPS移動 + ステータス更新
  delivery_status 作成      driver_id, stop_order,          (assigned → in_transit
  (status = 'pending')      trip_number が入る               → delivered/absent)
                            (status = 'assigned')
```

### データ準備の手順

1. **管理画面 (Admin)** → デモデータ生成で対象日のpackages + delivery_statusを作成
2. **計画画面 (Plan)** → 日付を選択 → ルート生成 → 確定（driver_id, stop_order, trip_numberが割り当てられる）
3. **シミュレーター実行** → 確定済みルートに沿ってGPS移動 + 配送進捗がリアルタイムにDBへ書き込まれる

## 動かし方

### 前提

- Python 3.10+
- `psycopg2` (`pip install psycopg2-binary`)
- `lastmile-app/.env.local` に Postgres 接続情報

### シーン別コマンド

#### シーン1: フルデモ（推奨）
管理画面でデータ生成 → Plan画面でルート確定 → シミュレーター実行。
GPS移動 + 配達ステータス + 渋滞 + 滞在記録がすべて連動。

```bash
python3 tools/gps_simulator.py --date 2026-03-13 --reset --start depot --ramp 3,6,9,12 --speed 15
```

#### シーン2: GPS位置だけ動かしたい（ステータスは変えない）
ルート確定後、Monitor画面の地図上でドライバーが動く様子だけ見せたい場合。
delivery_statusは変更しないのでPlan画面の表示には影響しない。

```bash
python3 tools/gps_simulator.py --date 2026-03-13 --no-status --no-traffic --no-dwell
```

#### シーン3: 途中経過から見せる（ランダム散布）
ドライバーがすでに配送中の状態から始める。depotからの出発を見せる必要がないプレゼン向け。

```bash
python3 tools/gps_simulator.py --date 2026-03-13 --start random --speed 10
```

#### シーン4: 不在多発シナリオ
不在率を高めに設定して、不在検知アラートや再配達の発生を見せたい場合。

```bash
python3 tools/gps_simulator.py --date 2026-03-13 --reset --absence-rate 0.30 --speed 20
```

#### シーン5: 特定ドライバーだけ動かす
デバッグや特定ドライバーの挙動確認用。

```bash
python3 tools/gps_simulator.py --date 2026-03-13 --drivers DRV-001,DRV-003
```

#### シーン6: 高速再生
短時間で全配送を完了させたい場合。

```bash
python3 tools/gps_simulator.py --date 2026-03-13 --speed 30 --interval 0.5
```

### パラメータ一覧

| パラメータ | デフォルト | 説明 |
|-----------|----------|------|
| `--date` | 今日の日付 | シミュレーション対象日 |
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

シミュレータは起動時に `delivery_status` + `packages` テーブルから **指定日付のルート確定済みデータを読み込む**。
`delivery_status` に `driver_id` と `stop_order` が入っていないと動かない（`No routes found` で終了する）。

```sql
-- どの日付にルート確定済みデータがあるか確認
SELECT ds.date, COUNT(*) AS total, COUNT(ds.driver_id) AS assigned, COUNT(ds.stop_order) AS has_route
FROM delivery_status ds
GROUP BY ds.date ORDER BY ds.date DESC;
```

| 状態 | 結果 |
|------|------|
| デモデータ生成のみ（ルート未確定） | `assigned = 0`, `has_route = 0` → **動かない** |
| ルート確定済み | `assigned > 0`, `has_route > 0` → **動く** |

### --reset の対象

| テーブル | リセット内容 |
|---------|------------|
| `driver_locations` | 初期位置 (depot or random) に更新 |
| `delivery_status` | ステータスを `assigned` に戻し、completed_at/is_absent/attempt_countクリア |
| `delivery_dwell` | 対象日・対象ドライバーのレコード削除 |
| `traffic_realtime` | 直近2時間のレコード削除 |
| `driver_locations_history` | 直近1時間のレコード削除 |

### 画面の見方

```
============================================================================
 Delivery Simulator  Date: 2026-03-13  Speed: 15.0x  Tick: 42  Elapsed: 1m05s
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

### ステータス遷移

```
assigned/loaded → (移動開始) → in_transit → (到着+滞在完了) → delivered (88%) or absent (12%)
```

### 確認用SQL

```sql
-- 現在位置
SELECT * FROM driver_locations ORDER BY driver_id;

-- 配達進捗
SELECT status, count(*) FROM delivery_status WHERE date = '2026-03-13' GROUP BY status ORDER BY status;

-- 渋滞状況
SELECT h3_index::text, congestion_level, speed_ratio FROM traffic_realtime WHERE datetime >= NOW() - INTERVAL '2 hours' ORDER BY congestion_level DESC;

-- 滞在記録
SELECT driver_id, count(*), avg(dwell_seconds)::int avg_sec FROM delivery_dwell WHERE date = '2026-03-13' GROUP BY driver_id ORDER BY driver_id;

-- 軌跡数
SELECT driver_id, count(*) FROM driver_locations_history WHERE recorded_at > NOW() - INTERVAL '1 hour' GROUP BY driver_id ORDER BY driver_id;
```

### トラブルシューティング

| 症状 | 対処 |
|------|------|
| `No routes found` | 指定日付のルートが確定済みか確認。管理画面でデータ生成 → Plan画面でルート確定が必要 |
| `ModuleNotFoundError: psycopg2` | `pip install psycopg2-binary`。`.venv`が有効な場合はそのvenv内で実行すること |
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
