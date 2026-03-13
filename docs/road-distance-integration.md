# 道路距離の導入 — 現状分析と移行プラン

## 現状: 直線距離ベースの3箇所

ルート生成で「距離」を使っている箇所は3つあり、全て直線距離(Haversine)が根拠。

### ① Snowflake H3コスト行列 (`H3_COST_MATRIX.DISTANCE_KM`)

```
SP_GENERATE_H3_COST_MATRIX
  → R10セル中心点間の Haversine を DISTANCE_KM として格納
  → TOTAL_COST = distance_km + risk*0.5 + weather*0.15
```

- 887セル × 886対向 × 13時間 × 7日 ≈ 71.5M行
- `travelCost()` がコスト行列ヒット時にこの値を返す
- ルート順序決定（貪欲法）、2-opt改善判定、ETA計算で使用

### ② Haversine フォールバック (`route.ts:haversine()`)

```typescript
function travelCost(..., costMap): number {
  const c = costMap.get(costKey(fromH3, toH3));
  if (c !== undefined) return c;     // ← ① がヒット
  return haversine(fromLat, fromLng, toLat, toLng);  // ← ここ
}
```

- コスト行列にペアが無い場合のフォールバック
- 同一R10セル内の移動（fromH3 === toH3）もここに落ちる

### ③ エリアクラスタリングの親和性スコア (`haversine()` 直接呼出)

```typescript
// assignClustersByArea / tryAssignSingle 内
areaAffinity = haversine(cluster.centroidLat, ..., avgLat, avgLng);
```

- クラスタ→ドライバー割当のスコアリングに使用
- 相対比較用なので直線距離でも実用上の問題は小さい

### ④ 所要時間への変換

```typescript
const AVG_SPEED_KMH = 15;  // 固定値
function travelMinutes(distKm: number): number {
  return (distKm / AVG_SPEED_KMH) * 60;
}
```

- ①②の距離を一律15km/hで時間に変換
- 道路距離を導入しても、この変換は残る（ただし実道路距離なら精度向上）

---

## 直線距離と道路距離の乖離

豊洲エリア（配送対象エリア）は運河・高速道路・鉄道で分断されており、直線距離と道路距離の乖離が大きい。

| パターン | 直線距離 | 道路距離（推定） | 倍率 |
|---------|---------|---------------|------|
| 同一街区内 | 0.1km | 0.12km | 1.2× |
| 運河を挟む | 0.3km | 0.8km | 2.7× |
| 大通り迂回 | 0.5km | 0.9km | 1.8× |
| 湾岸エリア横断 | 1.5km | 3.2km | 2.1× |

**平均乖離倍率: 1.5〜2.5×** (都市部の一般的な値)

影響:
- 迂回率の計算が実態と乖離（直線距離ベースの迂回率4倍 → 実際は2倍程度の可能性）
- ETA精度が低い（直線距離15km/hは道路距離だと実質30km/h走行に相当）
- 2-optの改善判定が不正確（運河越えのペナルティが反映されない）

---

## 道路距離を導入する4つの選択肢

### 選択肢1: OSRM サイドカー (推奨)

```
┌──────────────── SPCS Service ─────────────────┐
│  lastmile-app:3000 ←HTTP→ osrm-backend:5000  │
│                            └── kanto.osrm     │
└───────────────────────────────────────────────┘
```

**方式**: OSM道路データをプリプロセスし、OSRMコンテナをSPCSにサイドカーとして追加。
`/table/v1/driving` APIで N×N の距離行列・所要時間行列を一括取得。

**API呼出し例**:
```
GET http://osrm:5000/table/v1/driving/139.79,35.64;139.80,35.65;...
    ?annotations=duration,distance
→ {
    "durations": [[0, 180, 420, ...], ...],  // 秒
    "distances": [[0, 1200, 3400, ...], ...]  // メートル
  }
```

| 項目 | 内容 |
|------|------|
| 精度 | 実道路距離・所要時間。一方通行・右左折コストも考慮 |
| 速度 | N=50 の距離行列で 50〜100ms |
| データ | 関東エリアOSM抽出 (≈200MB processed) |
| 更新 | OSMデータを月次でリビルド (osrm-extract → osrm-partition → osrm-customize) |
| SPCS追加 | CPU 1, Memory 2Gi。既存specにコンテナ追加 |
| 工数 | 4〜6時間 |

**メリット**: Snowflakeコスト行列への依存を削減、リアルタイム計算可能、PostGIS不要
**デメリット**: SPCSリソース増、OSMデータ管理が必要

---

### 選択肢2: Google/Mapbox Distance Matrix API (外部SaaS)

**方式**: 外部APIで道路距離を取得。

```
GET https://maps.googleapis.com/maps/api/distancematrix/json
    ?origins=35.64,139.79|35.65,139.80
    &destinations=35.64,139.79|35.65,139.80
    &key=API_KEY
```

| 項目 | 内容 |
|------|------|
| 精度 | 最高（リアルタイム交通情報含む） |
| 速度 | 200〜500ms / リクエスト |
| コスト | Google: $5/1000要素、Mapbox: $5/1000要素 |
| 制約 | Google: 1リクエスト最大25×25=625要素。12ドライバー×50件 → 多数リクエスト必要 |
| 工数 | 2〜3時間 |

**メリット**: 最も高精度、インフラ管理不要
**デメリット**: 従量課金（490件/日で月$200〜$500）、レイテンシ、外部依存

---

### 選択肢3: Snowflake H3コスト行列の距離改善

**方式**: `SP_GENERATE_H3_COST_MATRIX` の `DISTANCE_KM` をHaversineから道路距離に置換。

```sql
-- 現状
DISTANCE_KM = HAVERSINE(from_lat, from_lng, to_lat, to_lng)

-- 改善案: 道路迂回係数 (detour factor) を適用
DISTANCE_KM = HAVERSINE(...) * DETOUR_FACTOR(from_h3, to_h3)
```

**DETOUR_FACTOR の推定方法**:
- 方法A: 定数倍率（都市部は1.4、水域隣接は2.5）→ 粗いが即実装可能
- 方法B: OSRMで事前にサンプリング（887セル中の代表100ペア）して回帰モデルを作成
- 方法C: pg_lake に道路ネットワークを構築し `pgr_dijkstra` で全ペア計算

| 項目 | 方法A | 方法B | 方法C |
|------|------|------|------|
| 精度 | 低 (±40%) | 中 (±15%) | 高 (±5%) |
| 工数 | 30分 | 3時間 | 8時間+ |
| 前提 | なし | OSRM一時利用 | PostGIS + pgrouting |

---

### 選択肢4: PostGIS + pgrouting (pg_lake)

**方式**: pg_lake に道路ネットワークをインポートし、`pgr_dijkstra` で最短経路を計算。

```sql
-- 道路ネットワーク構築
SELECT pgr_createTopology('road_network', 0.00001);

-- 2点間の最短距離
SELECT sum(cost) FROM pgr_dijkstra(
  'SELECT id, source, target, cost, reverse_cost FROM road_network',
  (SELECT nearest_node FROM packages WHERE package_id = $1),
  (SELECT nearest_node FROM packages WHERE package_id = $2)
);

-- N×N距離行列
SELECT * FROM pgr_dijkstraCostMatrix(
  'SELECT id, source, target, cost, reverse_cost FROM road_network',
  ARRAY[node1, node2, ..., nodeN]
);
```

| 項目 | 内容 |
|------|------|
| 精度 | 高。実道路距離 |
| 速度 | N=50 で 2〜5秒 (12ドライバー × 2便 = 最大24回 → 1〜2分) |
| 前提 | OSMデータのインポート (`osm2pgrouting`)、PostGIS extensions |
| pg_lake対応 | pgrouting拡張が使えるか要確認（Snowflake Postgres） |
| 工数 | 8〜12時間 |

**メリット**: SQLで完結、既存pg_lakeインフラを活用
**デメリット**: pgrouting拡張の可否未確認、初期構築が重い、N×Nが遅い

---

## 推奨アプローチ

```
                        精度
                         ↑
         選択肢4         │   選択肢2
     (pgr_dijkstra)      │   (Google API)
                         │
         選択肢1         │
     ★ (OSRM サイドカー) │
                         │
         選択肢3A        │
     (定数倍率)          │
                         └──────────────→ 導入コスト
```

### 段階的導入プラン

| Phase | 内容 | 工数 | 効果 | 状態 |
|-------|------|------|------|------|
| ~~Phase 0~~ | ~~選択肢3A: 定数倍率 `×1.4`~~ | ~~30分~~ | ~~ETA精度の即時改善~~ | **スキップ** — Phase 1で完全に上書きされるため不要 |
| **Phase 1** | 選択肢1: OSRM サイドカー導入 | 4-6h | 実道路距離・所要時間。2-opt/貪欲法の精度大幅向上 | ✅ 実装済 |
| **Phase 2** | OSRM `/route` でルート形状も取得 → 地図表示の改善 | +2h | ルートが実道路に沿った表示になる | ✅ 実装済 |
| **Phase 2.5** | `exclude=motorway` で高速道路回避 | +0.5h | 配送トラック向けの一般道ルート生成 | ✅ 実装済 |
| **Phase 3** | 選択肢4: PostGIS道路NW構築（Phase 1と並行可） | 8-12h | `pgr_TSP` による厳密最適化が可能に | 未着手 |

> **Phase 0 スキップ理由**: Phase 1〜2を全て実施する前提では、定数倍率×1.4は
> Phase 1のOSRM導入で完全に上書きされる。SP変更もAVG_SPEED_KMH変更も二度手間になるため省略。

---

## 実装時の変更箇所

### ~~Phase 0 (定数倍率)~~ — スキップ

### Phase 1 (OSRM) ← ここから開始 ✅

| ファイル | 変更 | 状態 |
|---------|------|------|
| `osrm/Dockerfile` | 関東OSMデータ抽出 + osrm-backend v5.27.1, MLD | ✅ |
| `lastmile-app/service-spec.yaml` | OSRM サイドカーコンテナ追加 | ✅ |
| `route.ts` `fetchOsrmTableBatch()` | OSRM `/table` API呼出し (バッチ対応) | ✅ |
| `route.ts` `fetchOsrmMatrix()` | N×N行列をOSRM_BATCH_SIZE=100で分割取得 | ✅ |
| `route.ts` `travelCost()` | 3-tier: OSRM距離 → H3コスト行列 → Haversine | ✅ |
| `route.ts` `travelMinutes()` | 2-tier: OSRM所要時間 → dist/AVG_SPEED_KMH | ✅ |
| `route.ts` `haversine()` | OSRM不可時のフォールバック専用 | ✅ |

### Phase 2 (ルート形状) ✅

| ファイル | 変更 | 状態 |
|---------|------|------|
| `route.ts` `fetchOsrmRouteSegment()` | OSRM `/route` API (ROUTE_SEGMENT_SIZE=25) | ✅ |
| `route.ts` `fetchOsrmRoute()` | 長ルートを分割取得 + 部分フォールバック | ✅ |
| `route.ts` trip.route | 実道路形状のGeoJSON座標を使用 | ✅ |
| フロントエンド地図 | PathLayerが実道路に沿った表示に | ✅ |

### Phase 2.5 (高速道路回避) ✅

| ファイル | 変更 | 状態 |
|---------|------|------|
| `route.ts` `fetchOsrmTableBatch()` | `&exclude=motorway` 追加 | ✅ |
| `route.ts` `fetchOsrmMatrix()` (バッチ) | `&exclude=motorway` 追加 | ✅ |
| `route.ts` `fetchOsrmRouteSegment()` | `&exclude=motorway` 追加 | ✅ |

---

## 変更履歴

| 日付 | 内容 |
|------|------|
| 2026-03-12 | 初版作成。直線距離の依存箇所分析 + 4選択肢比較 + 段階的導入プラン |
| 2026-03-13 | Phase 0 をスキップに変更（Phase 1で上書きされるため）。Phase 1+2 実装完了 |
| 2026-03-13 | Phase 2: 部分フォールバック修正（1セグメント失敗で全ルート直線化→失敗セグメントのみ直線化）|
| 2026-03-13 | Phase 2.5: `exclude=motorway` 追加。OSRM全API (table/route) で高速道路を除外し一般道ルートを生成 |
