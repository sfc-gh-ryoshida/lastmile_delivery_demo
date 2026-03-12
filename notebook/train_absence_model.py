import sys
sys.path.insert(0, "/Users/ryoshida/Desktop/env/pg_lake/notebook")
from snowpark_session import create_snowpark_session
import pandas as pd
import numpy as np
from xgboost import XGBClassifier
from sklearn.model_selection import train_test_split
from sklearn.metrics import classification_report, roc_auc_score
from snowflake.ml.registry import Registry

session = create_snowpark_session("fsi_japan_connection")
session.use_database("LASTMILE_DB")
session.use_schema("ML")

print("=== 6-1: Absence Prediction Model (XGBoost) ===")
print("Loading data...")

query = """
SELECT
    dh.DELIVERY_ID,
    dh.H3_INDEX_R8,
    dh.H3_INDEX_R9,
    DAYOFWEEK(dh.DATE) AS DAY_OF_WEEK,
    HOUR(dh.COMPLETED_AT) AS HOUR_OF_DAY,
    dh.ATTEMPT_COUNT,
    dh.IS_ABSENT,
    COALESCE(ba.BUILDING_TYPE, 'unknown') AS BUILDING_TYPE,
    COALESCE(ba.HAS_ELEVATOR, false) AS HAS_ELEVATOR,
    COALESCE(ba.HAS_DELIVERY_BOX, false) AS HAS_DELIVERY_BOX,
    COALESCE(ba.AVG_FLOORS, 5) AS AVG_FLOORS,
    COALESCE(ap.ABSENCE_RATE, 0.1) AS HIST_ABSENCE_RATE,
    COALESCE(ap.SAMPLE_COUNT, 0) AS HIST_SAMPLE_COUNT
FROM LASTMILE_DB.ANALYTICS.DELIVERY_HISTORY dh
LEFT JOIN LASTMILE_DB.ANALYTICS.BUILDING_ATTRIBUTES ba
    ON dh.H3_INDEX_R9 = ba.H3_INDEX
LEFT JOIN LASTMILE_DB.ANALYTICS.ABSENCE_PATTERNS ap
    ON dh.H3_INDEX_R8 = ap.H3_INDEX
    AND DAYOFWEEK(dh.DATE) = ap.DAY_OF_WEEK
    AND HOUR(dh.COMPLETED_AT) = ap.HOUR
WHERE dh.STATUS IN ('delivered', 'absent')
"""

df_sp = session.sql(query)
df = df_sp.to_pandas()
print(f"Loaded {len(df)} rows")
print(f"Absent rate: {df['IS_ABSENT'].mean():.3f}")

building_type_map = {'house': 0, 'apartment': 1, 'office': 2, 'unknown': 3}
df['BUILDING_TYPE_ENC'] = df['BUILDING_TYPE'].map(building_type_map).fillna(3).astype(int)
df['HAS_ELEVATOR'] = df['HAS_ELEVATOR'].astype(int)
df['HAS_DELIVERY_BOX'] = df['HAS_DELIVERY_BOX'].astype(int)
df['IS_ABSENT'] = df['IS_ABSENT'].astype(int)

feature_cols = [
    'DAY_OF_WEEK', 'HOUR_OF_DAY',
    'BUILDING_TYPE_ENC', 'HAS_ELEVATOR', 'HAS_DELIVERY_BOX', 'AVG_FLOORS',
    'HIST_ABSENCE_RATE', 'HIST_SAMPLE_COUNT'
]

X = df[feature_cols]
y = df['IS_ABSENT']

X_train, X_test, y_train, y_test = train_test_split(X, y, test_size=0.2, random_state=42, stratify=y)
print(f"Train: {len(X_train)}, Test: {len(X_test)}")

absent_count = y_train.sum()
non_absent_count = len(y_train) - absent_count
scale_ratio = non_absent_count / max(absent_count, 1)

model = XGBClassifier(
    n_estimators=200,
    max_depth=5,
    learning_rate=0.1,
    scale_pos_weight=scale_ratio,
    eval_metric='logloss',
    random_state=42,
    n_jobs=-1
)
model.fit(X_train, y_train)

y_pred = model.predict(X_test)
y_prob = model.predict_proba(X_test)[:, 1]

print("\n=== Classification Report ===")
print(classification_report(y_test, y_pred, target_names=['delivered', 'absent']))
auc = roc_auc_score(y_test, y_prob)
print(f"ROC AUC: {auc:.4f}")

importance = dict(zip(feature_cols, model.feature_importances_.tolist()))
print("\n=== Feature Importance ===")
for f, imp in sorted(importance.items(), key=lambda x: -x[1]):
    print(f"  {f}: {imp:.4f}")

print("\n=== Registering model to LASTMILE_DB.ML ===")
reg = Registry(session=session, database_name="LASTMILE_DB", schema_name="ML")

sample_input = X_test.head(10).reset_index(drop=True)

report = classification_report(y_test, y_pred, output_dict=True)

mv = reg.log_model(
    model,
    model_name="ABSENCE_PREDICTOR",
    version_name="V1",
    sample_input_data=sample_input,
    conda_dependencies=["xgboost"],
    target_platforms=["SNOWPARK_CONTAINER_SERVICES"],
    metrics={
        "roc_auc": float(auc),
        "absent_precision": float(report['1']['precision']),
        "absent_recall": float(report['1']['recall']),
    },
    comment="XGBoost absence prediction model for last-mile delivery (Koto-ku)"
)

print(f"Model registered: {mv.model_name} version {mv.version_name}")
print("Done!")
session.close()
