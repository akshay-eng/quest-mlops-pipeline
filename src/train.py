"""Train a RandomForest classifier on Quest lab result data."""
import pandas as pd
import numpy as np
from sklearn.ensemble import RandomForestClassifier
from sklearn.model_selection import train_test_split
from sklearn.metrics import accuracy_score, precision_score, recall_score, f1_score
import joblib
import json
import os
import sys

DATA_PATH    = os.environ.get("DATA_PATH",    "data/lab_results.csv")
MODEL_PATH   = os.environ.get("MODEL_PATH",   "model/drug_test_classifier.pkl")
METRICS_PATH = "model/metrics.json"

print("=== Quest MLOps — Model Training ===")

if not os.path.exists(DATA_PATH):
    print(f"ERROR: Data file not found: {DATA_PATH}")
    sys.exit(1)

df = pd.read_csv(DATA_PATH)
print(f"Loaded {len(df)} records from {DATA_PATH}")

required_cols = [
    "age", "test_type_code", "collection_hour",
    "days_since_hire", "panel_size", "specimen_type", "result",
]
for col in required_cols:
    if col not in df.columns:
        print(f"ERROR: Missing column: {col}")
        sys.exit(1)

X = df.drop("result", axis=1)
y = df["result"]

X_train, X_test, y_train, y_test = train_test_split(X, y, test_size=0.2, random_state=42)
print(f"Train: {len(X_train)}  Test: {len(X_test)}")

model = RandomForestClassifier(n_estimators=100, random_state=42)
model.fit(X_train, y_train)

y_pred = model.predict(X_test)
metrics = {
    "accuracy":  round(float(accuracy_score(y_test, y_pred)), 4),
    "precision": round(float(precision_score(y_test, y_pred, zero_division=0)), 4),
    "recall":    round(float(recall_score(y_test, y_pred, zero_division=0)), 4),
    "f1":        round(float(f1_score(y_test, y_pred, zero_division=0)), 4),
    "n_train":   len(X_train),
    "n_test":    len(X_test),
}

print("\n=== Metrics ===")
for k, v in metrics.items():
    print(f"  {k}: {v}")

ACCURACY_THRESHOLD = float(os.environ.get("ACCURACY_THRESHOLD", "0.75"))
if metrics["accuracy"] < ACCURACY_THRESHOLD:
    print(f"\nERROR: Accuracy {metrics['accuracy']} below threshold {ACCURACY_THRESHOLD}")
    sys.exit(1)

os.makedirs("model", exist_ok=True)
joblib.dump(model, MODEL_PATH)
with open(METRICS_PATH, "w") as f:
    json.dump(metrics, f, indent=2)

print(f"\nModel saved  : {MODEL_PATH}")
print(f"Metrics saved: {METRICS_PATH}")
print("=== Training complete ===")
