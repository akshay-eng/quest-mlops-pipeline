"""
Evidently AI Cloud — Model Monitoring Reporter
Reads real predictions from LOG_PATH and uploads a DataDrift + Classification
report to Evidently Cloud. Falls back to synthetic data if log is absent.

Usage:
  pip install evidently pandas
  EVIDENTLY_API_KEY=<token> python monitor_evidently.py

GitHub Actions / K8s CronJob:
  Set env vars: EVIDENTLY_API_KEY, EVIDENTLY_PROJECT_ID, LOG_PATH
"""

import os
import json
import random
from datetime import datetime, timezone

import pandas as pd

EVIDENTLY_API_KEY    = os.environ.get("EVIDENTLY_API_KEY", "")
EVIDENTLY_PROJECT_ID = os.environ.get("EVIDENTLY_PROJECT_ID", "019d38af-88af-77a3-b6f0-ce8bb837307c")
EVIDENTLY_URL        = os.environ.get("EVIDENTLY_URL", "https://app.evidently.cloud")
LOG_PATH             = os.environ.get("LOG_PATH", "/data/predictions.jsonl")
REFERENCE_PATH       = os.environ.get("REFERENCE_PATH", "data/reference.jsonl")

MODEL_NAME    = "drug-test-classifier"
MODEL_VERSION = os.environ.get("GITHUB_SHA", "local")[:7]

FEATURE_NAMES = ["age", "test_type_code", "collection_hour",
                 "days_since_hire", "panel_size", "specimen_type"]


# ---------------------------------------------------------------------------
# Load reference distribution (saved by train_simple.py at build time)
# ---------------------------------------------------------------------------

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

    # Fallback: synthetic reference
    print("[evidently] Reference file not found — using synthetic reference")
    random.seed(42)
    n = 500
    rows = []
    for _ in range(n):
        rows.append({
            "age":             random.uniform(18, 65),
            "test_type_code":  random.randint(1, 7),
            "collection_hour": random.randint(6, 18),
            "days_since_hire": random.uniform(30, 3650),
            "panel_size":      random.randint(5, 20),
            "specimen_type":   random.randint(0, 2),
            "target":          random.randint(0, 1),
            "prediction":      random.randint(0, 1),
            "prediction_proba": random.uniform(0.3, 0.9),
        })
    return pd.DataFrame(rows)


# ---------------------------------------------------------------------------
# Load current batch from real prediction log (or synthetic fallback)
# ---------------------------------------------------------------------------

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
            df = pd.DataFrame(records)
            # Rename prediction_proba to match column mapping if needed
            return df

    # Fallback: synthetic current with injected drift
    print(f"[evidently] No prediction log found at {LOG_PATH} — using synthetic current batch")
    random.seed(int(datetime.now(timezone.utc).timestamp()) % 9999)
    n = 200
    rows = []
    for _ in range(n):
        rows.append({
            "age":             random.uniform(18, 32),        # younger — drifted
            "test_type_code":  random.randint(1, 7),
            "collection_hour": random.randint(13, 18),        # later hours — drifted
            "days_since_hire": random.uniform(30, 1000),      # newer employees — drifted
            "panel_size":      random.randint(5, 20),
            "specimen_type":   random.randint(0, 2),
            "target":          random.randint(0, 1),
            "prediction":      random.randint(0, 1),
            "prediction_proba": random.uniform(0.25, 0.95),
        })
    return pd.DataFrame(rows)


# ---------------------------------------------------------------------------
# Upload report to Evidently Cloud
# ---------------------------------------------------------------------------

def upload_report():
    if not EVIDENTLY_API_KEY:
        print("[evidently] EVIDENTLY_API_KEY not set — skipping upload.")
        return False

    try:
        from evidently import ColumnMapping
        from evidently.report import Report
        from evidently.metric_preset import DataDriftPreset, ClassificationPreset
        from evidently.ui.workspace.cloud import CloudWorkspace
    except ImportError:
        print("[evidently] Package not installed — run: pip install evidently")
        return False

    reference = _load_reference()
    current   = _load_current()

    # Ensure common columns
    common_cols = FEATURE_NAMES + ["target", "prediction", "prediction_proba"]
    reference = reference[[c for c in common_cols if c in reference.columns]]
    current   = current[[c for c in common_cols if c in current.columns]]

    column_mapping = ColumnMapping(
        target="target",
        prediction="prediction",
        numerical_features=["age", "collection_hour", "days_since_hire", "panel_size"],
        categorical_features=["test_type_code", "specimen_type"],
    )

    report = Report(
        metrics=[
            DataDriftPreset(),
            ClassificationPreset(),
        ],
        metadata={
            "model":   MODEL_NAME,
            "version": MODEL_VERSION,
        },
        tags=[MODEL_NAME, "quest-diagnostics", "k8s"],
    )
    report.run(
        reference_data=reference,
        current_data=current,
        column_mapping=column_mapping,
    )

    print(f"[evidently] Connecting to {EVIDENTLY_URL} ...")
    ws = CloudWorkspace(token=EVIDENTLY_API_KEY, url=EVIDENTLY_URL)

    print(f"[evidently] Uploading to project {EVIDENTLY_PROJECT_ID} ...")
    ws.add_report(EVIDENTLY_PROJECT_ID, report)

    print(f"[evidently] Report uploaded → {EVIDENTLY_URL}/projects/{EVIDENTLY_PROJECT_ID}")
    return True


if __name__ == "__main__":
    print(f"[evidently] Model: {MODEL_NAME}  Version: {MODEL_VERSION}")
    success = upload_report()
    if not success:
        print("[evidently] Monitoring step skipped.")
    exit(0)
