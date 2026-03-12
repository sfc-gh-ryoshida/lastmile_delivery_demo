# lastmile-app — 配送所長アプリ

配送所長の業務を「計画 → モニタリング → 振り返り」の 3 画面で支援する Next.js アプリ。

## 技術スタック

| カテゴリ | 技術 |
|---------|------|
| フレームワーク | Next.js 16 (App Router) |
| UI | React 19 + shadcn/ui v4 + Tailwind CSS 4 |
| 地図 | deck.gl 9 + react-map-gl + Mapbox GL JS 3 |
| グラフ | Recharts |
| DB 接続 | pg (node-postgres) → Snowflake Postgres |
| SF 接続 | snowflake-sdk → Snowflake 本体 (天気・管理画面のみ) |

## 開発

```bash
cp .env.example .env.local   # 環境変数を設定
npm install
npm run dev                  # http://localhost:3000
```

## 画面構成

| タブ | 用途 | 使用時間帯 |
|------|------|-----------|
| 計画 (Plan) | リスクマップ、荷物一覧、天気、ルート生成・割当て・積込確認 | 前日 16:00〜 |
| 現場 (Monitor) | ドライバー位置、進捗、アラート、渋滞、ルート再調整、次便生成 | 当日 8:00〜19:00 |
| 振り返り (Review) | KPI、不在ヒートマップ、需要予測、ドライバー実績、日次締め | 当日 18:00〜 |

## API Routes (33 本)

詳細は [docs/api-specification.md](../docs/api-specification.md) を参照。

### データアクセスパス

| データ種別 | アクセス方式 | 例 |
|-----------|-------------|-----|
| 操業データ (OLTP) | `pgQuery()` → Postgres | drivers, packages, delivery_status |
| ML 出力 | `pgQuery()` → ft_* Foreign Table | ft_risk_scores, ft_kpi_daily |
| Snowflake 分析 | `sfQuery()` → Snowflake 直接 | RISK_SCORES, H3_COST_MATRIX |
| 天気 | `sfQuery()` → Snowflake | V_WEATHER_FORECAST_LIVE |

## SPCS デプロイ

```bash
docker build --platform linux/amd64 -t lastmile-app:latest .
docker tag lastmile-app:latest <REGISTRY>/lastmile-app:latest
docker push <REGISTRY>/lastmile-app:latest
```

## 関連ドキュメント

- [DB 設計書](../docs/database-design.md)
- [API 仕様書](../docs/api-specification.md)
- [アプリ設計書](../docs/app-architecture.md)
- [ルート最適化アルゴリズム](../docs/route-generation-algorithm.md)
