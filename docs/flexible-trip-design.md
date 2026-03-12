# 柔軟便管理 + 業務フロー改善 設計書

## 1. 概要

現状の trip1/trip2 固定構造を、動的 N 便構造に変更する。  
これにより以下を統一的に実現する:

- 1日1便・2便・3便以上のドライバー対応
- 再調整結果の DB 永続化
- 次便確定の DB 永続化
- ドライバー緊急離脱時の荷物再割当
- 積込完了確認
- 日次締め（持戻処理）
- SLA 違反トラッキング
- ドライバー出勤管理 UI

---

## 2. DB スキーマ変更

### 2.1 delivery_status テーブル

```sql
-- 新カラム追加
ALTER TABLE delivery_status
  ADD COLUMN trip_number integer DEFAULT 1,
  ADD COLUMN stop_order integer;

-- CHECK 制約更新 (loaded, returned を追加)
ALTER TABLE delivery_status
  DROP CONSTRAINT delivery_status_status_check;
ALTER TABLE delivery_status
  ADD CONSTRAINT delivery_status_status_check
  CHECK (status IN ('pending','assigned','loaded','in_transit','delivered','absent','failed','returned'));

-- インデックス追加
CREATE INDEX idx_delivery_status_trip ON delivery_status (driver_id, date, trip_number);
```

### 2.2 ステータス遷移図

```
pending → assigned → loaded → in_transit → delivered
                                         → absent  → (次便で再試行 or returned)
                                         → failed  → (次便で再試行 or returned)
         ← (緊急離脱: assigned/loaded に戻して driver_id 変更)
                                                     returned (日次締め: 未完了を持戻)
```

| 遷移 | トリガー | API |
|---|---|---|
| pending → assigned | ルート確定 | POST /api/plan/routes/assign |
| assigned → loaded | 積込完了 | POST /api/plan/routes/load-confirm |
| loaded → in_transit | 配送開始 | (既存シミュレーション) |
| in_transit → delivered | 配達完了 | (既存シミュレーション) |
| in_transit → absent | 不在 | (既存シミュレーション) |
| in_transit → failed | 配達失敗 | (既存シミュレーション) |
| absent/failed → assigned | 次便組込 | POST /api/monitor/routes/next-trip (confirm=true) |
| assigned → assigned | 再調整確定 | POST /api/monitor/routes/readjust (confirm=true) |
| * → assigned | 緊急離脱 | POST /api/monitor/driver-withdraw |
| 未完了 → returned | 日次締め | POST /api/review/daily-close |

### 2.3 trip_number のルール

- ルート生成時: 自動割当 (trip_number = 1, 2, ... N)
- 次便確定時: trip_number = 現在の最大 + 1
- 緊急離脱時: 移管先ドライバーの次の便番号で割当
- 1便のみのドライバー: trip_number = 1 のみ

---

## 3. API 変更

### 3.1 POST /api/plan/routes/generate (既存改修)

**変更点**: trip1/trip2 固定構造を N 便に変更

現状:
```ts
driverTrips.set(d.driver_id, { trip1: TripLoad, trip2: TripLoad });
```

変更後:
```ts
driverTrips.set(d.driver_id, { trips: TripLoad[] }); // trips[0]=1便, trips[1]=2便, ...
```

- `driver.max_trips` を参照して便数上限を決定
- 時間帯プールを便数に応じて動的に分割
- レスポンスの `TripAssignment.trip` は既に `number` なので互換性あり

### 3.2 POST /api/plan/routes/assign (既存改修)

**変更点**: trip_number と stop_order を書き込み

```ts
// 現状
INSERT INTO delivery_status (package_id, driver_id, date, status)
VALUES ($1, $2, $3, 'assigned')

// 変更後
INSERT INTO delivery_status (package_id, driver_id, date, status, trip_number, stop_order)
VALUES ($1, $2, $3, 'assigned', $4, $5)
```

リクエスト body に `trip_number` と `stop_order` を追加:
```ts
interface AssignRequest {
  date: string;
  moves: {
    package_id: string;
    from_driver_id: string | null;
    to_driver_id: string;
    trip_number: number;   // 追加
    stop_order: number;    // 追加
  }[];
}
```

### 3.3 POST /api/monitor/routes/readjust (既存改修)

**変更点**: `confirm` パラメータ追加

```ts
// リクエスト
{ date, driver_id, skip_absent?, confirm?: boolean, trip_number?: number }

// confirm=false (デフォルト): 現行通りプレビューのみ返却
// confirm=true: DB に stop_order を UPDATE
```

確定時の SQL:
```sql
UPDATE delivery_status
SET stop_order = $1, updated_at = NOW()
WHERE package_id = $2 AND date = $3 AND driver_id = $4 AND trip_number = $5
```

### 3.4 POST /api/monitor/routes/next-trip (既存改修)

**変更点**: trip_number を動的に判定 + `confirm` パラメータ

```ts
// リクエスト
{ date, driver_id, confirm?: boolean }

// 現行: trip_number = 1 の結果を見て trip_number = 2 を生成
// 変更: 最新 trip の結果を見て trip_number = max + 1 を生成
```

動的便番号の判定:
```sql
SELECT MAX(trip_number) as current_trip
FROM delivery_status
WHERE driver_id = $1 AND date = $2
```

確定時:
```sql
-- absent/failed を新便に組み込み
UPDATE delivery_status
SET trip_number = $1, stop_order = $2, status = 'assigned', driver_id = $3, updated_at = NOW()
WHERE package_id = $4 AND date = $5

-- 既存2便荷物も stop_order 更新
UPDATE delivery_status
SET stop_order = $1, updated_at = NOW()
WHERE package_id = $2 AND date = $3 AND trip_number = $4
```

### 3.5 POST /api/monitor/driver-withdraw (新規)

ドライバー緊急離脱: 対象ドライバーの未完了荷物を他ドライバーに再割当。

```ts
interface WithdrawRequest {
  date: string;
  withdraw_driver_id: string;
  reason?: string;
}

// レスポンス
interface WithdrawResponse {
  withdrawn_packages: number;
  reassignments: {
    package_id: string;
    new_driver_id: string;
    new_trip_number: number;
    new_stop_order: number;
  }[];
  unassigned_packages: string[];  // 割当先が見つからない場合
}
```

処理フロー:
1. 対象ドライバーの未完了荷物を取得 (status NOT IN delivered)
2. 他アクティブドライバーの空き容量を計算
3. nearest-neighbor + 容量制約で割当
4. `confirm=true` で DB 更新 (driver_id, trip_number, stop_order 変更)

### 3.6 POST /api/plan/routes/load-confirm (新規)

積込完了: assigned → loaded に一括遷移。

```ts
interface LoadConfirmRequest {
  date: string;
  driver_id: string;
  trip_number: number;
}

// 処理
UPDATE delivery_status
SET status = 'loaded', updated_at = NOW()
WHERE driver_id = $1 AND date = $2 AND trip_number = $3 AND status = 'assigned'
```

### 3.7 POST /api/review/daily-close (新規)

日次締め: 未完了荷物を `returned` に変更し、当日の集計を返す。

```ts
interface DailyCloseRequest {
  date: string;
}

// 処理
UPDATE delivery_status
SET status = 'returned', updated_at = NOW()
WHERE date = $1 AND status IN ('assigned', 'loaded', 'in_transit', 'pending', 'absent', 'failed')
  AND status != 'delivered'

// レスポンス: 当日集計
{
  date: string;
  total_packages: number;
  delivered: number;
  returned: number;
  absent: number;
  failed: number;
  delivery_rate: number;  // delivered / total * 100
  by_driver: { driver_id, name, delivered, returned, trips_completed }[];
}
```

### 3.8 SLA 違反トラッキング

readjust API のレスポンスに SLA 情報を追加:

```ts
// 既存レスポンスに追加
{
  ...existing,
  sla_violations: {
    package_id: string;
    time_window: string;
    estimated_eta: string;
    delay_minutes: number;
  }[];
}
```

### 3.9 ドライバー出勤管理

```ts
// POST /api/plan/driver-attendance
interface AttendanceRequest {
  date: string;
  updates: {
    driver_id: string;
    is_active: boolean;
  }[];
}

// 処理
UPDATE drivers SET is_active = $1 WHERE driver_id = $2
```

---

## 4. UI 変更

### 4.1 RouteReadjustPanel (改修)

- 「確定」ボタン追加 → readjust API を `confirm=true` で再呼出
- 確定後: 成功メッセージ表示、パネルリセット

### 4.2 NextTripPanel → TripManagePanel (改修)

- "2便ルート再生成" → "次便ルート生成" に文言変更
- 現在の便番号を表示 (trip N → trip N+1 を生成)
- 「確定」ボタン追加
- trip1_summary → previous_trip_summary に汎化

### 4.3 DriverWithdrawPanel (新規)

Monitor ページのドライバー選択時に表示:
- 「緊急離脱」ボタン → 確認ダイアログ → API 呼出
- 再割当結果を表示 (どの荷物がどのドライバーに移ったか)

### 4.4 LoadConfirmPanel (新規)

Plan ページのルート確定後に表示:
- ドライバー × 便ごとの「積込完了」ボタン
- assigned → loaded へ遷移

### 4.5 DailyClosePage (新規)

Review ページに「日次締め」タブ追加:
- 当日の全荷物サマリー
- 未完了一覧
- 「締め実行」ボタン → 確認ダイアログ
- 締め後の集計レポート表示

### 4.6 DriverAttendancePanel (新規)

Plan ページに配置:
- ドライバー一覧 + トグル (出勤/欠勤)
- 変更を一括保存

---

## 5. 既存互換性

### 5.1 trip_number DEFAULT 1

- 既存データは trip_number = 1 として扱われる
- next-trip API の trip_number = 2 クエリは引き続き動作

### 5.2 stop_order NULL 許容

- 既存データは stop_order = NULL
- ルート確定時に初めて値がセットされる

### 5.3 フロントエンド互換

- generate API のレスポンス形式 (TripAssignment[]) は変更なし
- assign API の moves に trip_number/stop_order が追加されるが、既存呼出元も更新する

---

## 6. 実装順序

1. **DB マイグレーション** — trip_number, stop_order 追加、CHECK 制約更新
2. **assign API** — trip_number, stop_order 書き込み対応
3. **readjust API** — confirm モード追加
4. **next-trip API** — N 便対応 + confirm モード
5. **load-confirm API** — 新規
6. **driver-withdraw API** — 新規
7. **daily-close API** — 新規
8. **UI: RouteReadjustPanel** — 確定ボタン
9. **UI: NextTripPanel** — N 便対応 + 確定ボタン
10. **UI: DriverWithdrawPanel** — 新規
11. **UI: LoadConfirmPanel** — 新規
12. **UI: DailyClosePage** — 新規
13. **UI: DriverAttendancePanel** — 新規
14. **route generate API** — N 便対応 (trip1Pool/trip2Pool の動的化)
15. **SLA 違反情報** — readjust レスポンスに追加
