"""Run drift evaluation on the trained model using Evidently AI."""
import pandas as pd
import json
import os
import sys
from evidently.report import Report
from evidently.metric_preset import DataDriftPreset
from evidently import ColumnMapping

print("=== Quest MLOps — Model Evaluation ===")

METRICS_PATH = "model/metrics.json"
DATA_PATH    = "data/lab_results.csv"

if not os.path.exists(METRICS_PATH):
    print("ERROR: model/metrics.json not found. Run train.py first.")
    sys.exit(1)

with open(METRICS_PATH) as f:
    metrics = json.load(f)

print(f"Accuracy : {metrics['accuracy']}")
print(f"Precision: {metrics['precision']}")
print(f"Recall   : {metrics['recall']}")
print(f"F1       : {metrics['f1']}")

df        = pd.read_csv(DATA_PATH)
half      = len(df) // 2
reference = df.iloc[:half]
current   = df.iloc[half:]

column_mapping = ColumnMapping(
    target="result",
    numerical_features=["age", "collection_hour", "days_since_hire"],
    categorical_features=["test_type_code", "panel_size", "specimen_type"],
)

report = Report(metrics=[DataDriftPreset()])
report.run(
    reference_data=reference,
    current_data=current,
    column_mapping=column_mapping,
)

os.makedirs("reports", exist_ok=True)
report.save_html("reports/drift_report.html")

report_dict    = report.as_dict()
drift_detected = report_dict["metrics"][0]["result"].get("dataset_drift", False)
print(f"\nDrift detected: {drift_detected}")

if drift_detected:
    print("WARNING: Data drift detected. Model may need retraining with newer data.")

print("Drift report saved → reports/drift_report.html")
print("=== Evaluation complete ===")
