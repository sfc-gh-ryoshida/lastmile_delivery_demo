# ルート生成 改善プラン

## 現状の課題

現在のルート生成 (`/api/plan/routes/generate`) は **エリアクラスタリング + 貪欲法 + 2-opt** で配達ルートを決定している。

> A-1 (2-opt) と A-2 (エリアクラスタリング) は 2026-03-12 に実装済み。以下の課題表は改善前の記録。

| 問題 | 原因 | 影響 |
|------|------|------|
| 長距離ジャンプ | 貪欲法は直前の配達先からの最近傍のみ評価。全体俯瞰ができない | 迂回率 4倍超のルートが発生 |
| ルート交差 | 行って戻るパターン。辺が交差しても検出・修正しない | 走行距離 +20〜40% |
| エリア分散 | ドライバーへの荷物割当が地理的に分散しがち | 同エリアを複数ドライバーが通過 |
| 時間指定違反 | 時間帯ペナルティはソフト制約 (加点方式) のため遅着が発生 | quality_score 低下 |

### コスト行列は修正済み

H3_COST_MATRIX は以下の修正が完了しており、コスト値自体は正確:
- R9→R10 子セル展開 (H3_CELL_TO_CHILDREN_STRING): 120 → 887 セル
- デポセル追加 + BUILDING_ATTRIBUTES R10 親セル UNION
- 加算式 TOTAL_COST: `distance_km + risk*0.5 + weather*0.15`
- distance-cost 相関: 0.994

**→ 問題はアルゴリズム側にある。**

---

## 改善プラン一覧

### Phase A: PostGIS 不要 — 即実装可能

#### A-1. 2-opt 局所改善 ✅ 実装済み (2026-03-12)

**概要**: 貪欲法で生成したルートに対して、辺の交差を解消する局所探索を適用する。

**実装内容**:
- `twoOptImprove()` 関数を `greedySortWithETA()` の後段に配置
- H3コスト行列ベースでセグメント反転の改善判定 (`dAfter < dBefore - 0.001`)
- 反転後に全停車地点のETAを再計算（時間指定待ちを含む）
- 最大10反復、n < 4 の場合はスキップ
- 2-opt後の最終停車地点→デポの帰着時間も再計算

**計算量**: O(n²) × 反復回数。n≈27 (targetPerTrip) で通常 3〜10 反復で収束。

---

#### A-2. エリアクラスタリング → ドライバー割当 ✅ 実装済み (2026-03-12)

**概要**: 荷物を地理的にクラスタリングし、各クラスタをドライバーに割り当てる。

**実装内容**:
```
Step 1: タイムプール別に荷物を分類
        Pool[0] = 午前指定 + フレキシブル → 1便
        Pool[1] = 午後指定 + 夜間指定 → 2便
Step 2: 各プール内で H3 R8 (≈460m) セル単位でグループ化 (clusterPackages)
        ※ 隣接マージ (gridDisk) は密集エリアで全結合してしまうため不採用
Step 3: 大クラスタを分割 (splitLargeClusters)
        - targetPerTrip = ceil(totalPkgs / (drivers × avgTrips) × 1.3) ≈ 27件
        - targetWeight = minCapacity / avgTrips × 0.85 ≈ 149kg
        - 緯度→経度ソートで地理的に近い荷物を同一チャンクに維持
Step 4: クラスタをドライバーへ割当 (assignClustersByArea)
        - スコア = エリア親和性 × 5 + 既存荷物数 × 0.1 + 便ずれペナルティ
        - 割当不可時は個別フォールバック (tryAssignSingle)
Step 5: クラスタ内で貪欲法 + 2-opt
```

**実測結果** (490件, 12ドライバー):
- 割当: 306/490件、全12ドライバー使用
- 平均品質スコア: 70.3
- 未割当184件はシフト時間オーバーフロー（容量ではなく配送時間の制約）

---

#### A-3. 時間指定2段階割当 (優先度: 中)

**概要**: 時間指定荷物を先にルートに固定し、残りの荷物を空きスロットに挿入する。

**現状**: 全荷物を同じ貪欲法で処理。時間帯ペナルティはソフト制約。

**改善案**:
```
Step 1: 時間指定荷物をETA順にソート → ルートの骨格として固定
Step 2: フレキシブル荷物を最小コスト挿入 (cheapest insertion) で追加
         → 既存の2ストップ間に挿入した場合のコスト増分が最小の位置に挿入
```

**メリット**:
- 時間指定違反がゼロに近づく
- フレキシブル荷物が時間指定荷物の「間」を埋める形になり効率的

**工数**: 1〜2 時間

---

#### A-4. コスト行列の時間帯別参照 (優先度: 低)

**現状**: `HOUR = 10` 固定で全便のコスト行列を取得。

**改善案**: 
- 1便目 (08:00〜12:00): HOUR = 10
- 2便目 (13:00〜17:00): HOUR = 15
- 3便目以降: 該当時間帯

H3_COST_MATRIX は HOUR 8〜20 を全て保持しているので、クエリの WHERE 条件を変えるだけ。

**工数**: 30 分

---

### Phase B: PostGIS / 外部サービス利用

#### B-1. OSRM コンテナ連携 ✅ 実装済み (2026-03-13)

**概要**: OSRM (Open Source Routing Machine) の `/table` API でリアルな道路距離行列、`/route` API で実道路ルート形状を取得。

**構成**:
```
SPCS Compute Pool
├── lastmile-app (既存)
└── osrm-backend (サイドカー) ← 実装済み
    └── 関東エリアの道路データ (kanto-latest.osm.pbf → BBOX抽出)
```

**実装内容**:
- `osrm/Dockerfile`: osrm-backend v5.27.1, MLD アルゴリズム, BBOX=139.55,35.52,140.05,35.82 (東京23区+千葉西部)
- `service-spec.yaml`: OSRM サイドカーコンテナ追加
- `route.ts`: 3つの新関数
  - `fetchOsrmTableBatch()` — `/table` API (距離+所要時間行列)
  - `fetchOsrmMatrix()` — バッチ分割 (OSRM_BATCH_SIZE=100, max-table-size=200対応)
  - `fetchOsrmRoute()` / `fetchOsrmRouteSegment()` — `/route` API (ROUTE_SEGMENT_SIZE=25)
- `travelCost()`: 3-tier フォールバック (OSRM → H3コスト行列 → Haversine)
- `travelMinutes()`: 2-tier (OSRM所要時間 → dist/AVG_SPEED_KMH)
- 部分フォールバック: 失敗セグメントのみ直線化、成功セグメントは道路形状維持
- `exclude=motorway`: 全OSRM API呼出しで高速道路を回避 (配送トラック向け一般道ルート)
- `optimization_summary` に `osrm_enabled`, `osrm_points` 追加

**実測結果**: 全19トリップで実道路ルート形状を確認。運河・高速道路を正しく迂回。

---

#### B-2. pgr_TSP による巡回最適化 (優先度: 中)

**概要**: PostGIS + pgrouting の `pgr_TSP` で各ドライバーのルートを最適化。

**前提**: Phase 4 (道路ネットワーク構築) が完了していること。

**フロー**:
```
1. ドライバーの荷物リスト (N個) の最寄りノードを取得
   → ST_DistanceSphere(road_network.the_geom, ST_MakePoint(pkg.lng, pkg.lat))
2. pgr_dijkstraCostMatrix でN×Nコスト行列を生成
3. pgr_TSP で巡回順序を最適化
4. 結果の順序でstop_orderを設定
```

**SQL例**:
```sql
SELECT * FROM pgr_TSP(
  $$SELECT * FROM pgr_dijkstraCostMatrix(
    'SELECT id, source, target, cost, reverse_cost FROM road_network',
    (SELECT ARRAY_AGG(nearest_node) FROM package_nodes WHERE driver_id = $1)
  )$$,
  start_id := (SELECT nearest_node FROM depot_nodes WHERE depot_id = $2)
);
```

**メリット**: 実道路ネットワーク上での最適巡回順序
**デメリット**: N=50 で pgr_dijkstraCostMatrix が 2〜5秒。12ドライバー × 2便 = 最大24回で 1〜2分。

**工数**: 4〜8 時間 (Phase 4 完了後)

---

#### B-3. OR-Tools CVRP ソルバー (優先度: 将来)

**概要**: Google OR-Tools の Vehicle Routing Problem (VRP) ソルバーで、容量制約 + 時間枠付き巡回問題を厳密に解く。

**構成**: Python サイドカーコンテナ or Snowflake Notebook で実行。

```python
from ortools.constraint_solver import routing_enums_pb2, pywrapcp

manager = pywrapcp.RoutingIndexManager(len(locations), num_vehicles, depot_index)
routing = pywrapcp.RoutingModel(manager)

# 距離コールバック
routing.SetArcCostEvaluatorOfAllVehicles(transit_callback_index)

# 容量制約
routing.AddDimensionWithVehicleCapacity(demand_callback_index, 0, capacities, True, 'Capacity')

# 時間枠制約
time_dimension = routing.GetDimensionOrDie('Time')
for i, tw in enumerate(time_windows):
    time_dimension.CumulVar(manager.NodeToIndex(i)).SetRange(tw[0], tw[1])

solution = routing.SolveWithParameters(search_parameters)
```

**メリット**: 容量 + 時間枠 + 複数デポ + 複数便を同時最適化。最も精度が高い。
**デメリット**: Python ランタイムが必要。500荷物 × 12ドライバーで 10〜30秒。

**工数**: 6〜10 時間

---

## 推奨実装順序

```
Phase A (PostGIS不要)           Phase B (PostGIS/外部サービス)
─────────────────────           ─────────────────────────────
A-1. 2-opt           ✅ 実装済み
  ↓
A-2. エリアクラスタリング  ✅ 実装済み
  ↓
A-3. 時間指定2段階
  ↓
A-4. 時間帯別コスト参照
                                B-1. OSRM コンテナ ✅ 実装済み
                                  ↓
                                B-2. pgr_TSP (Phase 4 完了後)
                                  ↓
                                B-3. OR-Tools CVRP (将来)
```

## 期待される効果

| 改善 | 走行距離 | 時間指定遵守率 | 品質スコア | 実装工数 |
|------|----------|--------------|-----------|---------|
| 旧 (貪欲法のみ) | baseline | ~85% | 65-80 | — |
| **✅ +A-1 (2-opt)** | **-15〜25%** | ~85% | 75-85 | 実装済み |
| **✅ +A-2 (クラスタリング)** | **-25〜35%** | ~85% | 70-85 | 実装済み |
| +A-3 (時間指定2段階) | -25〜35% | **~97%** | 85-92 | +1-2h |
| **✅ +B-1 (OSRM)** | **-30〜40%** | ~97% | 88-95 | 実装済み |
| +B-2 (pgr_TSP) | **-35〜45%** | ~97% | 90-96 | +4-8h |

※走行距離の改善率は一般的なVRPベンチマークに基づく目安値。実際の効果はデータの地理的分布に依存。

---

## 対象ファイル

| ファイル | 変更内容 |
|---------|---------|
| `lastmile-app/src/app/api/plan/routes/generate/route.ts` | A-1〜A-4 の全改善を実装 |
| `lastmile-app/src/app/api/monitor/routes/readjust/route.ts` | A-1 (2-opt) を readjust にも適用 |
| `docs/route-generation-algorithm.md` | アルゴリズム詳細ドキュメントに改善内容を反映 |
| `spcs/spcs_spec.yaml` | B-1 (OSRM コンテナ追加時) |

---

## 変更履歴

| 日付 | 内容 |
|------|------|
| 2026-03-12 | 初版作成。現状分析 + 6つの改善案を策定 |
| 2026-03-12 | A-1 (2-opt) + A-2 (エリアクラスタリング) 実装完了。結果: 306/490割当, avg_score=70.3 |
| 2026-03-13 | B-1 (OSRM) 実装完了。Phase 1: 距離行列+所要時間 (バッチ対応)、Phase 2: ルート形状 (セグメント分割+部分フォールバック)、Phase 2.5: exclude=motorway (高速道路回避) |
