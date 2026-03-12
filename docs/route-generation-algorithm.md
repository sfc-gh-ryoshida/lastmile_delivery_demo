# ルート生成エンジン — 設計・アルゴリズム詳細ドキュメント

## 概要

ラストワンマイル配送管理アプリにおけるルート自動生成は、計画画面 (Plan) からドライバーへの荷物割当と配達順序の最適化を行う中核機能である。
Snowflake (ML/分析データ) と Postgres (業務トランザクションデータ) を統合し、リスクスコア・不在予測・交通コスト・工事情報を考慮した複合最適化を実行する。

---

## アーキテクチャ

```
┌─────────────────┐
│  Plan UI         │  route-generate-panel.tsx
│  (フロントエンド)  │  → POST /api/plan/routes/generate
└────────┬────────┘
         │ { date, mode: "auto" }
         ▼
┌─────────────────────────────────────────────────────┐
│  ルート生成 API                                       │
│  src/app/api/plan/routes/generate/route.ts           │
│                                                       │
│  ┌───────────┐  ┌──────────────┐  ┌───────────────┐ │
│  │ Postgres   │  │ Snowflake    │  │ Snowflake     │ │
│  │ packages   │  │ RISK_SCORES  │  │ H3_COST_MATRIX│ │
│  │ drivers    │  │ ABSENCE_     │  │               │ │
│  │ road_      │  │ PATTERNS     │  │               │ │
│  │ construction│  │              │  │               │ │
│  └───────────┘  └──────────────┘  └───────────────┘ │
│                                                       │
│  [Phase 1] データ収集 & エンリッチメント               │
│  [Phase 2] 時間帯別プール分割                          │
│  [Phase 3] ドライバー割当 (容量制約 + エリア分散)       │
│  [Phase 4] 便別ルート順序最適化 (貪欲法 + ETA)        │
│  [Phase 5] シフト時間オーバーフロートリミング           │
│  [Phase 6] レスポンス構築                              │
└────────┬────────────────────────────────────────────┘
         │
         ▼
┌─────────────────┐     ┌─────────────────────────┐
│  ルート確定       │ ──▶ │ POST /api/plan/routes/   │
│  (ユーザー操作)   │     │ assign                    │
└─────────────────┘     │ → delivery_status UPSERT │
                         └─────────────────────────┘
```

---

## データソース

### Postgres (トランザクション系)

| テーブル | 用途 | 主要カラム |
|---------|------|-----------|
| `packages` | 当日の配送荷物一覧 | package_id, lat, lng, h3_index, time_window, weight, volume, is_redelivery, recipient_type, address |
| `drivers` | 稼働中ドライバー | driver_id, name, vehicle_capacity (kg), vehicle_volume (m³), skill_level (1-5), area_assignment, shift_start, shift_end, max_trips, depot_id (FK) |
| `depots` | 配送拠点 | depot_id, name, address, lat, lng |
| `road_construction` | 工事エリア (H3セル) | h3_index, start_date, end_date, restriction_type |
| `delivery_status` | 配達ステータス管理 | package_id, driver_id, date, status |

### Snowflake (分析/ML系)

| テーブル | 用途 | 主要カラム |
|---------|------|-----------|
| `ANALYTICS.RISK_SCORES` | ML予測: 配送リスクスコア (遅配確率) | H3_INDEX, DATE, HOUR, RISK_SCORE (0.0〜1.0) |
| `ANALYTICS.ABSENCE_PATTERNS` | ML予測: エリア別不在率 | H3_INDEX, DAY_OF_WEEK, HOUR, ABSENCE_RATE |
| `ANALYTICS.H3_COST_MATRIX` | H3セル間の移動コスト行列 | FROM_H3 (R10), TO_H3 (R10), DATE, HOUR, TOTAL_COST |

---

## 定数パラメータ

| パラメータ | 値 | 説明 |
|-----------|-----|------|
| `DWELL_MINUTES` | 5分 (対面), 1分 (置き配) | 配達方法別の滞在時間 |
| `AVG_SPEED_KMH` | 15 km/h | 市街地平均走行速度 (Haversineフォールバック時) |
| `DEPOT_TURNAROUND_MINUTES` | 20分 | 便間のデポ帰還→再出発の所要時間 |
| `MAX_PACKAGES_PER_TRIP` | 50個 | 1便あたりの最大荷物数 |
| デポ座標 | ドライバーごとにDB管理 (`depots` テーブル) | 配送拠点 (複数デポ対応) |

---

## アルゴリズム詳細

### Phase 1: データ収集 & エンリッチメント

3つのデータソースからの並列取得:
```
Promise.all([
  Postgres: packages (当日分),
  Postgres: drivers (稼働中),
  Postgres: road_construction (当日有効)
])
```

取得後、Snowflake からのエンリッチメントを順次実行 (各ステップはtry-catchで保護、Snowflake障害時もPostgresデータのみで動作):

1. **リスクスコア付与**: `ANALYTICS.RISK_SCORES` から `DATE + HOUR=10` でH3セル別リスクを取得し、各荷物の `h3_index` でJOIN
2. **不在率付与**: `ANALYTICS.ABSENCE_PATTERNS` から `DAY_OF_WEEK + HOUR=10` で取得
3. **工事ペナルティ**: `road_construction` のH3セルに該当する荷物の `risk_score` を `max(現在値, 0.8)` に引き上げ
4. **H3コスト行列ロード**: 全荷物+デポのH3セルをR10解像度に集約し、`ANALYTICS.H3_COST_MATRIX` から該当ペアを取得

#### コスト関数 (travelCost)

```
travelCost(from, to):
  1. H3R10セルが異なる場合 → H3_COST_MATRIX を参照
  2. コスト行列にエントリがない場合 → Haversine距離 (直線距離) にフォールバック
  3. 同一H3R10セル内 → Haversine距離
```

H3R10解像度 (≈15m辺) でのコスト行列は、実際の道路ネットワーク・渋滞情報・信号待ちを加味した実効コストであり、単純な直線距離より現実的なルート選定が可能。

---

### Phase 2: 時間帯別プール分割

荷物を時間指定に基づいて4つのプールに分割:

```
time_window          → プール分類
─────────────────────────────────
終了 ≤ 13:00         → 午前 (morningPkgs)
開始 ≥ 17:00         → 夜間 (eveningPkgs)
それ以外の時間指定     → 午後 (afternoonPkgs)
時間指定なし           → フレキシブル (flexPkgs)
```

便への割り当てプール構成:
- **1便目プール** = 午前 + フレキシブル (朝出発の便で配達)
- **2便目プール** = 午後 + 夜間 (デポ帰還後の午後便で配達)

**設計意図**: 時間指定荷物を対応する便に優先配置し、フレキシブル荷物で1便目の積載率を最大化する。

---

### Phase 3: ドライバー割当 (容量制約 + エリア分散)

ドライバーを `skill_level` 降順でソート (熟練者優先)。

#### 割当スコアリング

各荷物に対して全ドライバーをスキャンし、以下のスコアで最適ドライバーを選定:

```
score = (現便の荷物数 × 2) + (全便合計荷物数) + エリアマッチボーナス

エリアマッチボーナス:
  ドライバーのarea_assignmentと荷物のh3_indexの
  先頭4文字が一致する場合 → -5 (スコアを下げる = 優先)
```

#### 制約条件 (いずれかに違反 → そのドライバーをスキップ)

1. **重量制約**: `現在重量 + 荷物重量 > vehicle_capacity` → NG
2. **体積制約**: `現在体積 + 荷物体積 > vehicle_volume` → NG
3. **件数制約**: `現便の件数 ≥ MAX_PACKAGES_PER_TRIP (50)` → NG

#### 割当順序

荷物はリスクスコア昇順 (低リスク優先) でソートしてから割当:

```
1. trip1Pool (午前+フレキ) をリスク昇順で → 各荷物をtrip1に割当試行
   → trip1で容量オーバーの場合はtrip2にフォールバック
2. trip2Pool (午後+夜間) をリスク昇順で → trip2に割当
```

**設計意図**: 低リスク荷物を先に割り当てることで、ドライバー間の負荷分散が均等になる。高リスク荷物は残った空きスロットに配置される。

#### スコアの効果

- `現便の荷物数 × 2` : **便内の均等化**を強く推進。荷物が少ない便のドライバーが優先される
- `全便合計荷物数` : **ドライバー間の均等化**。総荷物数が少ないドライバーが優先される
- `エリアマッチ -5` : **地理的効率性**。担当エリアの荷物をそのドライバーに集中させる

---

### Phase 4: 便別ルート順序最適化 (貪欲法 + ETA計算)

各ドライバーの各便について、`greedySortWithETA()` で配達順序を決定する。

#### 貪欲法 (Nearest Neighbor with Penalties)

デポを起点として、残り荷物から次の配達先を選定:

```
for each remaining package:
    dist = travelCost(current → package)          // H3コスト行列 or Haversine
    travel = dist / AVG_SPEED_KMH × 60            // 移動時間 (分)
    arriveAt = currentTime + travel

    // 時間帯ペナルティ
    if (arriveAt < time_window.start):
        twPenalty = (start - arriveAt) × 0.1       // 早着: 軽いペナルティ (待ち時間)
    if (arriveAt > time_window.end):
        twPenalty = (arriveAt - end) × 2            // 遅着: 重いペナルティ (遅延)

    // 不在ペナルティ
    if (absence_rate > 0.4 AND arriveAt < 16:00):
        absencePenalty = 0.3                        // 高不在率エリアを午後に後回し

    score = dist + twPenalty + absencePenalty
    → scoreが最小の荷物を次の配達先として選択
```

#### ETA (到着予想時刻) 計算

```
eta = max(arriveAt, time_window.start)   // 早着の場合は時間帯開始まで待機
currentTime = eta + DWELL_MINUTES (5分)  // 滞在後に次へ出発
```

#### 帰着時刻計算

最終配達先 → デポまでのHaversine距離から帰着時刻を算出:
```
returnMinutes = lastStop.eta + DWELL_MINUTES + travel(lastStop → depot)
```

---

### Phase 5: シフト時間オーバーフロートリミング

帰着予想時刻がシフト終了時刻を超える場合、末尾の荷物から順に削除:

```
while (ordered.length > 0):
    last = ordered[末尾]
    if (last.eta + DWELL_MINUTES + travel(last → depot) ≤ shiftEnd):
        break    // シフト内に収まる
    ordered.pop() // 最後の荷物を除外 → 未割当に戻る
```

**設計意図**: シフト超過による残業を防止。除外された荷物は `unassigned_packages` としてレスポンスに含まれ、UIで「未割当」として表示される。

#### 便間の時間管理

```
2便目の出発時刻 = 1便目の帰着時刻 + DEPOT_TURNAROUND_MINUTES (20分)
```

---

### Phase 6: 品質スコアリング (Quality Scoring)

ルート生成後、便単位・ドライバー単位で品質を定量評価する。所長が全ドライバーのルートをレビューする際に「要確認」の判断基準として使用。

#### 便品質スコア (`scoreTripQuality`)

基準点 **80点** からの加減点方式。最終スコアは 0〜100 にクランプ。

| カテゴリ | 条件 | 加減点 | フラグ |
|---------|------|--------|-------|
| **時間指定遵守** | 全件遵守 | **+10** | — |
| | 遅着 (end超過) / 早着 (start-15分未満) | **-(違反率×35)** | `時間指定違反 N/M件 (遅延計X分)` |
| | 時間指定荷物なし | **+5** | — |
| **リスク集中** | 高リスク (≥0.7) 荷物あり | **-(件数×4, 上限20)** | `高リスク N件` |
| | 中リスク (0.4〜0.7) が30%超 | **-5** | `中リスク多 N件` |
| **シフト余裕** | 帰着後の余裕 < 10分 | **-12** | `シフト余裕 X分` |
| | 帰着後の余裕 < 30分 | **-5** | `シフト余裕 X分` |
| **迂回率** | 総走行距離 / (始点→終点直線距離) > 4倍 | **-((倍率-4)×5, 上限15)** | `迂回率 X.X倍` |
| **平均停車間距離** | > 1.0km | **-((距離-1.0)×8, 上限15)** | `平均停車間 X.XXkm` |
| **配送効率** | < 5件/h | **-5** | `配送効率 X.X件/h` |
| | > 12件/h | **+5** | — |
| **積載** | 重量 or 体積 > 95% | **-8** | `積載上限` |
| | 重量 or 体積 > 70% | **+3** | — |
| | 重量 < 15% かつ 8件未満 | **-10** | `積載過少 (重量X%)` |
| **再配達比率** | > 30% | **-5** | `再配達比率 X%` |
| **不在リスク** | 対面配達 × 不在率>0.4 が 4件以上 | **-(件数×2, 上限10)** | `不在リスク高エリアに対面N件` |

**スコアレンジの目安:**

| スコア | 意味 | UI表示 |
|--------|------|--------|
| 90〜100 | 優秀 — レビュー不要 | 緑バッジ |
| 70〜89 | 良好 — 軽微な懸念あり | 黄バッジ |
| < 70 | 要確認 — 所長レビュー推奨 | 赤バッジ + 警告アイコン |

#### ドライバー品質スコア (`scoreDriverQuality`)

全便のスコア平均を基準に、ドライバーレベルの追加チェックを行う。

```
score = avg(各便の品質スコア)

追加減点:
  - 高リスク荷物 > 5件 かつ skill_level < 3 → -10 ("スキル不足で高リスク多数")
```

`needs_review` フラグは **ドライバー品質スコア < 70** で true になる。UIではドライバーカードに赤枠 + 警告アイコンが表示され、「要確認 N名」バッジがリスト上部に表示される。

---

### Phase 7: レスポンス構築

#### ドライバー割当レスポンス

```typescript
{
  driver_id, driver_name, shift_start, shift_end,
  depot: { lat, lng, name },
  trips: [{
    trip: 1,
    packages: [{
      package_id, stop_order, address, weight, volume,
      time_window, is_redelivery, recipient_type, risk_score,
      lat, lng, eta
    }, ...],
    total_weight, total_volume, total_packages,
    departure_time, return_time,
    quality_score,        // 便品質スコア (0-100)
    quality_flags,        // 減点理由の配列
    route: [{ lat, lng }, ...]  // デポ → 各配達先 → デポ
  }, ...],
  total_packages, total_weight, total_volume,
  capacity_pct, volume_pct,
  quality_score,          // ドライバー品質スコア (0-100)
  quality_flags,          // ドライバーレベルの警告配列
  needs_review,           // true: 所長レビュー推奨 (score < 70)
  route: [...]            // 全便の結合ルート (地図表示用)
}
```

レスポンス全体に `review_needed_count` (要確認ドライバー数) を含む。
```

#### 最適化サマリー (optimization_summary)

UIの「最適化の根拠」セクションに表示されるメタデータ:

| フィールド | 説明 |
|-----------|------|
| `cost_matrix_pairs` | H3コスト行列のロードペア数 (0ならHaversineフォールバック) |
| `risk_applied_count` | リスクスコアが付与された荷物数 |
| `absence_applied_count` | 不在率が付与された荷物数 |
| `construction_penalty_count` | 工事ペナルティが適用された荷物数 |
| `time_window_count` | 時間指定ありの荷物数 |
| `redelivery_count` | 再配達の荷物数 |
| `recipient_breakdown` | 配送先タイプ別内訳 (apartment/office/house/other) |
| `avg_risk_score` | リスクスコアの平均値 |
| `morning_pool` / `afternoon_pool` / `evening_pool` / `flex_pool` | 時間帯別プールの荷物数 |

---

## 関連API

### POST /api/plan/routes/assign — ルート確定

ルート生成後にユーザーが「ルート確定」を押すと呼ばれる。

- 各荷物の `delivery_status` を UPSERT (INSERT or UPDATE)
- ステータスを `assigned` に変更
- `delivered` / `in_transit` のものは再割当不可 (ガード)

### POST /api/monitor/routes/readjust — ルート再調整

配送中にドライバーの現在位置から残ルートを再最適化する。

- ドライバーの現在GPS座標を `driver_locations` から取得
- 残り荷物 (`delivery_status` が delivered 以外) を取得
- リアルタイムの `RISK_SCORES` で再エンリッチ
- 不在・高リスク (>0.7) を後回しにするオプション (`skip_absent`)
- 時間指定荷物を優先した貪欲法で再配列

---

## フロントエンド連携

### route-generate-panel.tsx

| 機能 | 説明 |
|------|------|
| ルート生成ボタン | `POST /api/plan/routes/generate` を呼び出し |
| 最適化の根拠セクション | `optimization_summary` を折りたたみ表示 |
| ドライバー一覧 | 展開前: 件数、便数、重量/体積バー、シフト時間、帰着予定 |
| 便サマリーカード | 展開後: 件数/重量/体積/高リスク数、配送先タイプ、再配達内訳 |
| 荷物一覧 | 停車順、住所、種別アイコン、リスクバッジ、ETA、時間帯 |
| ドラッグ&ドロップ | 停車順の手動変更 (確定前のみ) |
| ルート確定ボタン | `POST /api/plan/routes/assign` で delivery_status を一括更新 |
| 地図連携 | `onGenerated` コールバックで PathLayer のルートデータを更新 |

### route-assignment-board.tsx

未割当荷物の手動割当UI。荷物選択 → ドライバー選択 → 個別割当。

---

## グレースフルデグラデーション

Snowflakeの各データソースは独立した try-catch で保護されており、障害時も機能が段階的に縮退する:

| Snowflakeデータ | 利用不可時の動作 |
|---------------|----------------|
| `RISK_SCORES` | リスクスコアなし (null) で割当。ルート順序のリスク考慮が無効化 |
| `ABSENCE_PATTERNS` | 不在率なし (null) で割当。不在回避ペナルティが無効化 |
| `H3_COST_MATRIX` | 全区間 Haversine (直線距離) にフォールバック。精度は低下するが動作は継続 |

**全Snowflake障害時**: Postgresのデータのみで、容量制約+エリア分散+最近傍法によるルート生成が可能。

---

## Snowflakeを使うからこその要素

本ルート生成エンジンは Snowflake の以下の機能群に依存しており、これらが無ければ同等の精度・運用効率は実現できない。

### 1. H3_COST_MATRIX — 大規模事前計算によるルーティング精度

| 項目 | 内容 |
|------|------|
| テーブル | `ANALYTICS.H3_COST_MATRIX` (FROM_H3, TO_H3, DATE, HOUR, TOTAL_COST) |
| H3解像度 | R10 (六角形セル間のペア) |
| 計算内容 | 道路ネットワーク + 交通パターン + 信号タイミングを考慮した移動コスト |

**Snowflakeでなければ困難な理由:**
- セル間ペアは N² のオーダーで増加し、日×時間帯ごとに異なるコストを持つ。通常のOLTPデータベースでは事前計算・保持が困難
- Snowflake の LARGE ウェアハウスによる並列計算で、全ペアを日次バッチ更新可能
- `costMap` が空の場合は Haversine (直線距離) にフォールバックするが、実道路距離との乖離は特に都市部で顕著 (最大2〜3倍の差異)

### 2. ML駆動のリスクスコアリング

| 項目 | 内容 |
|------|------|
| テーブル | `ANALYTICS.RISK_SCORES` (H3_INDEX R11, DATE, HOUR, RISK_SCORE, RISK_FACTORS) |
| モデル | LogisticRegression + 4因子加重平均 |
| セル数 | 4,413 (H3 R11, 豊洲配送エリア全域) |

**4因子の内訳:**

| 因子 | データソース | Snowflake固有性 |
|------|------------|----------------|
| weather_effect | `V_WEATHER_FORECAST_LIVE` (WeatherSource Marketplace) | Marketplace経由のリアルタイム気象データ |
| absence_rate | `ABSENCE_PATTERNS` (XGBoost ML出力) | Model Registry管理のMLモデル出力 |
| building_factor | `BUILDING_ATTRIBUTES` (Iceberg) | 大量の建物属性をIcebergで管理 |
| poi_factor | `V_POI_AREA_PROFILE` (R8, H3_CELL_TO_PARENT結合) | Snowflake上でのH3空間結合 |

**Snowflakeでなければ困難な理由:**
- 4因子のうち3つがSnowflake内で生成・管理されるデータ
- 天候データは WeatherSource Marketplace からのライブデータであり、別途API契約・ETL構築が不要
- 4,413セル × 日 × 24時間のスコアを毎晩再計算する処理は Snowflake の弾力的コンピュートでのみ実用的

### 3. XGBoost不在予測モデル (Model Registry)

| 項目 | 内容 |
|------|------|
| テーブル | `ANALYTICS.ABSENCE_PATTERNS` (H3_INDEX R11, DAY_OF_WEEK, HOUR, ABSENCE_RATE) |
| モデル | XGBoost (Registry: `ABSENCE_MODEL v2`) |
| 粒度 | 4,413セル × 7曜日 × 24時間 = 最大 741,384パターン |

**ルート生成での利用:**
- `absence_rate > 0.4 かつ 16:00前` の荷物にペナルティ (+5km) を加算し、不在率の高い配達先を後回しにする
- ドライバーが午前中に確実に受け取れる配達先を優先し、午後に不在リスクの高い地域を回す

**Snowflakeでなければ困難な理由:**
- Snowflake Model Registry でモデルのバージョン管理・推論パイプラインを一元管理
- 推論結果は Iceberg テーブルに直接書き出し → 外部のモデルサービングインフラが不要
- 曜日×時間帯の組み合わせ数が膨大で、OLTP DBでの推論実行は非現実的

### 4. pg_lake / Iceberg v3 パターン — ゼロETLのML出力連携

```
Snowflake Task Chain (23:00 JST)
  → SP_RECALC_RISK_SCORES() / SP_PREDICT_ABSENCE()
  → Iceberg v3 テーブル更新
  → S3 Parquet 自動書出
  → pg_lake Foreign Table (ft_*) で Postgres から即参照
  → ルート生成 API が通常の Postgres クエリで ML 出力を取得
```

| Foreign Table | 元テーブル | ルート生成での用途 |
|--------------|-----------|------------------|
| `ft_risk_scores` | RISK_SCORES | 荷物の H3 セルにリスクスコアを付与 |
| `ft_absence_patterns` | ABSENCE_PATTERNS | 配達時間帯の不在率でルート順序にペナルティ |

**Snowflakeでなければ困難な理由:**
- ML出力 → アプリDB への連携で、通常なら ETL パイプライン (Airflow, dbt等) + スケジューラが必要
- Iceberg v3 の自動 S3 Parquet 書出 + pg_lake の Foreign Table により、**データ移動ゼロ** で ML 出力がアプリから参照可能
- アプリ側のコードは通常の `SELECT * FROM ft_risk_scores WHERE date = $1` であり、Snowflake の存在を意識しない

### 5. WeatherSource Marketplace — ライブ気象データ

| 項目 | 内容 |
|------|------|
| ビュー | `V_WEATHER_FORECAST_LIVE` |
| 提供元 | WeatherSource (Snowflake Marketplace) |
| 利用箇所 | RISK_SCORES の weather_effect 因子 |

**Snowflakeでなければ困難な理由:**
- 気象API (OpenWeather, AccuWeather等) を別途契約 → ETL構築 → データ変換が必要
- Marketplace のシェアリングにより、SQL `SELECT` 1文でライブ気象データにアクセス可能
- リスクスコア再計算SP内で直接JOINするだけで天候をリスクに反映

### 6. Task Chain — 外部オーケストレータ不要の自動化

```
TASK_DAILY_ETL (毎日 23:00 JST)
  → SP_ETL_POSTGRES_SYNC()         -- Postgres → Snowflake 実績同期
  ├── TASK_RISK_SCORES              -- リスクスコア再計算 (天候+不在+建物+POI)
  │     └── TASK_DEMAND_FORECAST    -- 需要予測更新 (LightGBM Quantile ×3)
  └── TASK_ABSENCE_PATTERNS         -- 不在パターン予測 (XGBoost)
```

**Snowflakeでなければ困難な理由:**
- Airflow / Step Functions / cron 等の外部オーケストレータが不要
- Task の依存関係 (DAG) により、ETL完了後にML再計算が自動的にカスケード実行
- ルート生成APIは翌朝の呼び出し時に、前夜更新済みのスコアを参照するだけ

### 7. グレースフルデグラデーション — Snowflakeが落ちても動く設計

ルート生成APIでは、Snowflake由来の各データソースを**独立した try-catch** で保護:

```typescript
// リスクスコア取得 (障害時は null で継続)
try {
  const riskRows = await pgPool.query("SELECT * FROM ft_risk_scores WHERE ...");
  // → 荷物にリスクスコアを付与
} catch { /* リスクスコアなしで続行 */ }

// 不在パターン取得 (障害時は null で継続)
try {
  const absRows = await pgPool.query("SELECT * FROM ft_absence_patterns WHERE ...");
  // → 荷物に不在率を付与
} catch { /* 不在率なしで続行 */ }

// コスト行列取得 (障害時は Haversine フォールバック)
try {
  const costRows = await sfConn.execute("SELECT * FROM H3_COST_MATRIX WHERE ...");
  // → costMap に格納
} catch { /* costMap が空 → Haversine で距離計算 */ }
```

| 障害レベル | 影響 | ルート生成の動作 |
|-----------|------|---------------|
| 全Snowflakeダウン | ML出力なし、コスト行列なし | Postgres データのみで容量制約+最近傍法のルート生成。精度は低下するが動作は継続 |
| RISK_SCORES のみ障害 | リスク考慮なし | 配達順序のリスクペナルティが無効化。他のデータは正常利用 |
| H3_COST_MATRIX のみ障害 | 実道路コストなし | Haversine (直線距離) にフォールバック。都市部では2〜3倍の誤差 |

**Snowflake + pg_lake だからこそ可能な理由:**
- ft_* Foreign Table はSnowflake本体が落ちても、S3上のParquetファイルが残っていれば最終同期時点のデータで動作可能
- Snowflake直接接続 (H3_COST_MATRIX) のみ完全障害となるが、Haversineフォールバックでルート生成自体は継続
- 各データソースが独立しているため、部分障害がシステム全体を止めない

### まとめ: Snowflake無しとの比較

| 要素 | Snowflakeあり | Snowflake無し (Postgres単体) |
|------|-------------|---------------------------|
| 移動コスト | 道路ネットワーク+交通+信号考慮 (H3_COST_MATRIX) | Haversine直線距離 (精度低) |
| リスクスコア | 4因子ML (天候+不在+建物+POI), H3 R11粒度 | なし、または手動ルール |
| 不在予測 | XGBoost, 4,413セル×曜日×時間帯 | なし、または過去実績の単純集計 |
| 気象データ | Marketplace経由リアルタイム | 別途API契約+ETL必要 |
| ML出力連携 | Iceberg → S3 Parquet → ft_* (ゼロETL) | ETLパイプライン構築必要 |
| 日次更新 | Task Chain (DAG依存、外部ツール不要) | Airflow/cron等の外部オーケストレータ必要 |
| 障害耐性 | S3 Parquet残存でft_*は最終データで動作 | (該当なし) |
| スケーラビリティ | WH サイズ変更で計算量に対応 | サーバースペック固定 |

---

## 制限事項・今後の改善候補

1. **最近傍法の限界**: 貪欲法は局所最適であり、大域的最適解を保証しない。2-opt / Or-tools / CVRP ソルバーの導入で改善可能
2. **固定パラメータ**: DWELL_MINUTES, AVG_SPEED_KMH が定数。recipient_type 別の滞在時間差分や時間帯別の速度変動を反映可能
3. **2便制限**: 現在は最大2便。max_trips パラメータは存在するが、実装は trip1/trip2 の固定構造
4. **リアルタイム交通**: ルート生成時は HOUR=10 固定でコスト行列を参照。便ごとに時間帯を変えるとより精度が向上
5. **不在回避ロジック**: `absence_rate > 0.4 かつ 16:00前` のみ。閾値と時間帯のチューニング余地あり
6. **品質スコアの閾値チューニング**: 現在の加減点値は初期設定。運用データの蓄積に応じてパラメータ調整が必要
