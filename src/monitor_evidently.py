"""
Evidently AI — Local Model Monitoring
Reads predictions from LOG_PATH, runs DataDrift report,
saves HTML report + metrics JSON to OUTPUT_DIR.

K8s CronJob mounts the PVC at /data — both input and output go there.
Backend serves /data/drift_metrics.json and /data/drift_report.html.
"""

import os
import json
import random
from datetime import datetime, timezone

import pandas as pd

LOG_PATH       = os.environ.get("LOG_PATH",       "/data/predictions.jsonl")
REFERENCE_PATH = os.environ.get("REFERENCE_PATH", "/app/data/reference.jsonl")
OUTPUT_DIR     = os.environ.get("OUTPUT_DIR",     "/data")

MODEL_NAME    = "drug-test-classifier"
MODEL_VERSION = os.environ.get("GITHUB_SHA", "local")[:7]

FEATURE_NAMES = ["age", "test_type_code", "collection_hour",
                 "days_since_hire", "panel_size", "specimen_type"]


def _load_reference() -> pd.DataFrame:
    if os.path.exists(REFERENCE_PATH):
        records = []
        with open(REFERENCE_PATH) as f:
            for line in f:
                try:
                    records.append(json.loads(line.strip()))
                except Exception:
                    pass
        if records:
            print(f"[evidently] Loaded {len(records)} reference rows from {REFERENCE_PATH}")
            return pd.DataFrame(records)

    print("[evidently] Reference file not found — using synthetic reference")
    random.seed(42)
    rows = []
    for _ in range(500):
        rows.append({
            "age":              random.uniform(18, 65),
            "test_type_code":   random.randint(1, 7),
            "collection_hour":  random.randint(6, 18),
            "days_since_hire":  random.uniform(30, 3650),
            "panel_size":       random.randint(5, 20),
            "specimen_type":    random.randint(0, 2),
        })
    return pd.DataFrame(rows)


def _load_current() -> pd.DataFrame:
    if os.path.exists(LOG_PATH):
        records = []
        with open(LOG_PATH) as f:
            for line in f:
                try:
                    records.append(json.loads(line.strip()))
                except Exception:
                    pass
        if records:
            print(f"[evidently] Loaded {len(records)} live predictions from {LOG_PATH}")
            return pd.DataFrame(records)

    print(f"[evidently] No log at {LOG_PATH} — using synthetic drifted batch")
    random.seed(int(datetime.now(timezone.utc).timestamp()) % 9999)
    rows = []
    for _ in range(200):
        rows.append({
            "age":              random.uniform(18, 32),       # drifted younger
            "test_type_code":   random.randint(1, 7),
            "collection_hour":  random.randint(13, 18),       # drifted later
            "days_since_hire":  random.uniform(30, 1000),     # drifted newer hires
            "panel_size":       random.randint(5, 20),
            "specimen_type":    random.randint(0, 2),
        })
    return pd.DataFrame(rows)


def run():
    try:
        from evidently import ColumnMapping
        from evidently.report import Report
        from evidently.metric_preset import DataDriftPreset
    except ImportError as e:
        print(f"[evidently] Import error: {e}")
        return False

    reference = _load_reference()
    current   = _load_current()

    feat_cols = [c for c in FEATURE_NAMES if c in reference.columns and c in current.columns]
    reference = reference[feat_cols]
    current   = current[feat_cols]

    column_mapping = ColumnMapping(
        numerical_features  = ["age", "collection_hour", "days_since_hire", "panel_size"],
        categorical_features= ["test_type_code", "specimen_type"],
    )

    report = Report(metrics=[DataDriftPreset()])
    report.run(reference_data=reference, current_data=current, column_mapping=column_mapping)

    os.makedirs(OUTPUT_DIR, exist_ok=True)

    # 1) Save full interactive HTML report
    html_path = os.path.join(OUTPUT_DIR, "drift_report.html")
    report.save_html(html_path)
    print(f"[evidently] HTML report saved to {html_path}")

    # 2) Extract key metrics and save as JSON for the dashboard
    metrics_path = os.path.join(OUTPUT_DIR, "drift_metrics.json")
    try:
        d        = report.as_dict()
        features = []
        drift    = {}
        for metric in d.get("metrics", []):
            mtype  = metric.get("metric", "")
            result = metric.get("result", {})
            if "DatasetDriftMetric" in mtype:
                drift = {
                    "dataset_drift": result.get("dataset_drift", False),
                    "share_drifted": round(result.get("share_drifted_columns", 0), 4),
                    "n_drifted":     result.get("number_of_drifted_columns", 0),
                    "n_total":       result.get("number_of_columns", 0),
                }
                for col, data in result.get("drift_by_columns", {}).items():
                    features.append({
                        "name":        col,
                        "drift_score": round(float(data.get("drift_score", 0)), 4),
                        "drifted":     bool(data.get("drift_detected", False)),
                        "stat_test":   data.get("stattest_name", ""),
                        "threshold":   data.get("stattest_threshold", 0.05),
                    })
        features.sort(key=lambda f: (-int(f["drifted"]), -f["drift_score"]))
        output = {
            "model":      MODEL_NAME,
            "version":    MODEL_VERSION,
            "timestamp":  datetime.now(timezone.utc).isoformat(),
            "drift":      drift,
            "features":   features,
            "report_available": True,
        }
        with open(metrics_path, "w") as f:
            json.dump(output, f, indent=2)
        print(f"[evidently] Metrics JSON saved to {metrics_path}")
    except Exception as e:
        print(f"[evidently] Metrics extraction error: {e}")

    print("[evidently] Done.")
    return True


if __name__ == "__main__":
    print(f"[evidently] Model: {MODEL_NAME}  Version: {MODEL_VERSION}")
    success = run()
    if not success:
        print("[evidently] Monitoring step skipped.")
    exit(0)
