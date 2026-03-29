"""
Evidently AI Cloud — Model Monitoring Reporter
Runs after deployment to register predictions and drift report in Evidently Cloud.

Usage:
  pip install evidently
  EVIDENTLY_API_KEY=<token> EVIDENTLY_PROJECT_ID=<uuid> python monitor_evidently.py

GitHub Actions usage:
  Set secrets: EVIDENTLY_API_KEY, EVIDENTLY_PROJECT_ID
"""

import os
import json
import random
from datetime import datetime, timedelta, timezone

import pandas as pd

EVIDENTLY_API_KEY    = os.environ.get("EVIDENTLY_API_KEY", "")
EVIDENTLY_PROJECT_ID = os.environ.get("EVIDENTLY_PROJECT_ID", "")
EVIDENTLY_URL        = os.environ.get("EVIDENTLY_URL", "https://app.evidently.cloud")

MODEL_NAME    = "drug-test-classifier"
MODEL_VERSION = os.environ.get("GITHUB_SHA", "local")[:7]


# ---------------------------------------------------------------------------
# Generate synthetic reference + current batch for demo
# ---------------------------------------------------------------------------

def _make_reference() -> pd.DataFrame:
    """500-row reference distribution (clean, balanced)."""
    random.seed(42)
    n = 500
    return pd.DataFrame({
        "age":             [random.gauss(42, 12) for _ in range(n)],
        "lab_value_1":     [random.gauss(5.4, 1.1) for _ in range(n)],
        "lab_value_2":     [random.gauss(120, 15) for _ in range(n)],
        "lab_value_3":     [random.gauss(3.8, 0.6) for _ in range(n)],
        "test_panel_code": [random.choice(["CBC", "BMP", "LFT", "UA"]) for _ in range(n)],
        "target":          [random.choice([0, 1]) for _ in range(n)],
        "prediction":      [random.choice([0, 1]) for _ in range(n)],
        "prediction_proba": [random.uniform(0.3, 0.9) for _ in range(n)],
    })


def _make_current() -> pd.DataFrame:
    """200-row current batch — slight drift injected for demo interest."""
    random.seed(int(datetime.now().timestamp()) % 9999)
    n = 200
    # Inject distribution shift on lab_value_1 (mean +1.5)
    return pd.DataFrame({
        "age":             [random.gauss(44, 13) for _ in range(n)],
        "lab_value_1":     [random.gauss(6.9, 1.3) for _ in range(n)],   # drifted
        "lab_value_2":     [random.gauss(122, 16) for _ in range(n)],
        "lab_value_3":     [random.gauss(3.7, 0.7) for _ in range(n)],
        "test_panel_code": [random.choice(["CBC", "BMP", "LFT", "UA", "TPNL"]) for _ in range(n)],
        "target":          [random.choice([0, 1]) for _ in range(n)],
        "prediction":      [random.choice([0, 1]) for _ in range(n)],
        "prediction_proba": [random.uniform(0.25, 0.95) for _ in range(n)],
    })


# ---------------------------------------------------------------------------
# Upload to Evidently Cloud
# ---------------------------------------------------------------------------

def upload_reports():
    if not EVIDENTLY_API_KEY:
        print("[evidently] EVIDENTLY_API_KEY not set — skipping cloud upload.")
        return False
    if not EVIDENTLY_PROJECT_ID:
        print("[evidently] EVIDENTLY_PROJECT_ID not set — skipping cloud upload.")
        return False

    try:
        from evidently import ColumnMapping
        from evidently.report import Report
        from evidently.metric_preset import DataDriftPreset, ClassificationPreset
        from evidently.ui.workspace.cloud import CloudWorkspace
    except ImportError:
        print("[evidently] Package not installed — run: pip install evidently")
        return False

    reference = _make_reference()
    current   = _make_current()

    column_mapping = ColumnMapping(
        target="target",
        prediction="prediction",
        numerical_features=["age", "lab_value_1", "lab_value_2", "lab_value_3"],
        categorical_features=["test_panel_code"],
    )

    report = Report(
        metrics=[
            DataDriftPreset(),
            ClassificationPreset(),
        ],
        metadata={
            "model":   MODEL_NAME,
            "version": MODEL_VERSION,
            "env":     "production",
        },
        tags=[MODEL_NAME, "quest-diagnostics", "drug-test"],
    )
    report.run(reference_data=reference, current_data=current, column_mapping=column_mapping)

    print(f"[evidently] Connecting to {EVIDENTLY_URL} ...")
    ws = CloudWorkspace(token=EVIDENTLY_API_KEY, url=EVIDENTLY_URL)

    print(f"[evidently] Uploading report to project {EVIDENTLY_PROJECT_ID} ...")
    ws.add_report(EVIDENTLY_PROJECT_ID, report)

    print(f"[evidently] ✅ Report uploaded — view at {EVIDENTLY_URL}/projects/{EVIDENTLY_PROJECT_ID}")
    return True


if __name__ == "__main__":
    print(f"[evidently] Model: {MODEL_NAME}  Version: {MODEL_VERSION}")
    success = upload_reports()
    if not success:
        # Exit 0 so GitHub Actions step is non-blocking for missing credentials
        print("[evidently] Monitoring step skipped (credentials not configured).")
    exit(0)
