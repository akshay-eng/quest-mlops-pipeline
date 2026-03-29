"""
Evidently AI — backend routes
Serves drift_metrics.json and drift_report.html written by the K8s CronJob
(or the local monitor_evidently.py run) from OUTPUT_DIR / DATA_DIR.
"""

import os
import json
from fastapi import APIRouter
from fastapi.responses import JSONResponse, HTMLResponse

router = APIRouter()

# In K8s the CronJob writes to the PVC mounted at /data.
# Locally, point OUTPUT_DIR to wherever you ran monitor_evidently.py.
DATA_DIR = os.environ.get("OUTPUT_DIR", "/data")

METRICS_FILE = os.path.join(DATA_DIR, "drift_metrics.json")
REPORT_FILE  = os.path.join(DATA_DIR, "drift_report.html")


@router.get("/evidently/latest")
async def latest_metrics():
    """Return drift metrics JSON written by the monitoring CronJob."""
    if not os.path.exists(METRICS_FILE):
        return JSONResponse(
            {"error": "No metrics file found. Run monitor_evidently.py or wait for the CronJob."},
            status_code=404,
        )
    try:
        with open(METRICS_FILE) as f:
            data = json.load(f)
        return data
    except Exception as e:
        return JSONResponse({"error": str(e)}, status_code=500)


@router.get("/evidently/report", response_class=HTMLResponse)
async def drift_report():
    """Serve the full interactive Evidently HTML drift report."""
    if not os.path.exists(REPORT_FILE):
        return HTMLResponse(
            "<h2 style='font-family:sans-serif;padding:2rem'>No report yet."
            " Run <code>monitor_evidently.py</code> or wait for the K8s CronJob.</h2>",
            status_code=404,
        )
    with open(REPORT_FILE, encoding="utf-8") as f:
        html = f.read()
    return HTMLResponse(content=html)
