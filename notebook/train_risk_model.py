import sys
sys.path.insert(0, "/Users/ryoshida/Desktop/env/pg_lake/notebook")
from snowpark_session import create_snowpark_session
import pandas as pd
import numpy as np
from lightgbm import LGBMRegressor
from sklearn.model_selection import train_test_split
from sklearn.metrics import mean_absolute_error, root_mean_squared_error, r2_score
from snowflake.ml.registry import Registry

session = create_snowpark_session("fsi_japan_connection")
session.use_database("LASTMILE_DB")
session.use_schema("ML")

print("=== 6-2: Risk Scoring Model (LightGBM) ===")
print("Loading data...")

query = """
SELECT
    rs.H3_INDEX,
    rs.DATE,
    rs.HOUR,
    rs.RISK_SCORE,
    DAYOFWEEK(rs.DATE) AS DAY_OF_WEEK,
    COALESCE(ap.ABSENCE_RATE, 0.1) AS HIST_ABSENCE_RATE,
    COALESCE(ap.SAMPLE_COUNT, 0) AS HIST_SAMPLE_COUNT,
    COALESCE(wf.PRECIPITATION, 0) AS PRECIPITATION,
    COALESCE(wf.WIND_SPEED, 3) AS WIND_SPEED,
    COALESCE(wf.TEMPERATURE, 15) AS TEMPERATURE,
    CASE COALESCE(wf.WEATHER_CODE, 'clear')
        WHEN 'clear' THEN 0
        WHEN 'cloudy' THEN 1
        WHEN 'rain' THEN 2
        ELSE 0
    END AS WEATHER_CODE_ENC,
    COALESCE(ba.HAS_DELIVERY_BOX::INT, 0) AS HAS_DELIVERY_BOX,
    COALESCE(ba.AVG_FLOORS, 5) AS AVG_FLOORS
FROM LASTMILE_DB.ANALYTICS.RISK_SCORES rs
LEFT JOIN LASTMILE_DB.ANALYTICS.ABSENCE_PATTERNS ap
    ON rs.H3_INDEX = ap.H3_INDEX
    AND DAYOFWEEK(rs.DATE) = ap.DAY_OF_WEEK
    AND rs.HOUR = ap.HOUR
LEFT JOIN LASTMILE_DB.ANALYTICS.WEATHER_FORECAST wf
    ON SUBSTRING(rs.H3_INDEX, 1, 15) = wf.H3_INDEX
    AND rs.DATE = wf.DATETIME::DATE
    AND rs.HOUR = HOUR(wf.DATETIME)
LEFT JOIN LASTMILE_DB.ANALYTICS.BUILDING_ATTRIBUTES ba
    ON rs.H3_INDEX = ba.H3_INDEX
"""

df_sp = session.sql(query)
df = df_sp.to_pandas()
print(f"Loaded {len(df)} rows")
print(f"Risk score stats: mean={df['RISK_SCORE'].mean():.3f}, std={df['RISK_SCORE'].std():.3f}")

feature_cols = [
    'DAY_OF_WEEK', 'HOUR',
    'HIST_ABSENCE_RATE', 'HIST_SAMPLE_COUNT',
    'PRECIPITATION', 'WIND_SPEED', 'TEMPERATURE', 'WEATHER_CODE_ENC',
    'HAS_DELIVERY_BOX', 'AVG_FLOORS'
]

X = df[feature_cols].fillna(0)
y = df['RISK_SCORE']

X_train, X_test, y_train, y_test = train_test_split(X, y, test_size=0.2, random_state=42)
print(f"Train: {len(X_train)}, Test: {len(X_test)}")

model = LGBMRegressor(
    n_estimators=300,
    max_depth=6,
    learning_rate=0.05,
    num_leaves=31,
    random_state=42,
    n_jobs=-1,
    verbose=-1
)
model.fit(X_train, y_train)

y_pred = model.predict(X_test)
y_pred = np.clip(y_pred, 0, 1)

mae = mean_absolute_error(y_test, y_pred)
rmse = root_mean_squared_error(y_test, y_pred)
r2 = r2_score(y_test, y_pred)

print(f"\n=== Regression Metrics ===")
print(f"MAE:  {mae:.4f}")
print(f"RMSE: {rmse:.4f}")
print(f"R2:   {r2:.4f}")

importance = dict(zip(feature_cols, model.feature_importances_.tolist()))
print("\n=== Feature Importance ===")
for f, imp in sorted(importance.items(), key=lambda x: -x[1]):
    print(f"  {f}: {imp}")

print("\n=== Registering model to LASTMILE_DB.ML ===")
reg = Registry(session=session, database_name="LASTMILE_DB", schema_name="ML")

sample_input = X_test.head(10).reset_index(drop=True)

mv = reg.log_model(
    model,
    model_name="RISK_SCORER",
    version_name="V1",
    sample_input_data=sample_input,
    conda_dependencies=["lightgbm"],
    target_platforms=["SNOWPARK_CONTAINER_SERVICES"],
    metrics={
        "mae": float(mae),
        "rmse": float(rmse),
        "r2": float(r2),
    },
    comment="LightGBM risk scoring model for last-mile delivery (Koto-ku)"
)

print(f"Model registered: {mv.model_name} version {mv.version_name}")
print("Done!")
session.close()
