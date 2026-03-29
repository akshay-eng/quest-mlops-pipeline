"""
Evidently AI Cloud — backend route
Fetches snapshots and metrics from the Evidently Cloud project.
"""

import os
import asyncio
from functools import partial
from fastapi import APIRouter
from fastapi.responses import JSONResponse

router = APIRouter()

EVIDENTLY_API_KEY    = os.environ.get("EVIDENTLY_API_KEY", "")
EVIDENTLY_PROJECT_ID = os.environ.get("EVIDENTLY_PROJECT_ID", "019d38af-88af-77a3-b6f0-ce8bb837307c")
EVIDENTLY_URL        = "https://app.evidently.cloud"


# ---------------------------------------------------------------------------
# Sync helpers (run in executor so we don't block the event loop)
# ---------------------------------------------------------------------------

def _list_snapshots_sync():
    from evidently.ui.workspace.cloud import CloudWorkspace
    ws        = CloudWorkspace(token=EVIDENTLY_API_KEY, url=EVIDENTLY_URL)
    snapshots = ws.list_snapshots(EVIDENTLY_PROJECT_ID) or []
    results   = []
    for s in snapshots:
        results.append({
            "id":        str(s.id),
            "timestamp": s.timestamp.isoformat() if getattr(s, "timestamp", None) else None,
            "tags":      list(s.tags or []),
            "metadata":  dict(s.metadata or {}),
        })
    # Most recent first
    results.sort(key=lambda x: x["timestamp"] or "", reverse=True)
    return results


def _load_latest_sync():
    from evidently.ui.workspace.cloud import CloudWorkspace
    ws        = CloudWorkspace(token=EVIDENTLY_API_KEY, url=EVIDENTLY_URL)
    snapshots = ws.list_snapshots(EVIDENTLY_PROJECT_ID) or []
    if not snapshots:
        return None

    latest  = sorted(snapshots, key=lambda s: getattr(s, "timestamp", None) or "", reverse=True)[0]
    report  = ws.load_snapshot(EVIDENTLY_PROJECT_ID, latest.id)

    out = {
        "snapshot_id": str(latest.id),
        "timestamp":   latest.timestamp.isoformat() if getattr(latest, "timestamp", None) else None,
        "tags":        list(latest.tags or []),
        "metadata":    dict(latest.metadata or {}),
        "drift":       {},
        "classification": {},
        "features":    [],
    }

    try:
        d = report.as_dict()
        for metric in d.get("metrics", []):
            mtype  = metric.get("metric", "")
            result = metric.get("result", {})

            if "DatasetDriftMetric" in mtype:
                out["drift"] = {
                    "dataset_drift":   result.get("dataset_drift", False),
                    "share_drifted":   round(result.get("share_drifted_columns", 0), 4),
                    "n_drifted":       result.get("number_of_drifted_columns", 0),
                    "n_total":         result.get("number_of_columns", 0),
                }
                for col, data in result.get("drift_by_columns", {}).items():
                    out["features"].append({
                        "name":        col,
                        "drift_score": round(data.get("drift_score", 0), 4),
                        "drifted":     bool(data.get("drift_detected", False)),
                        "stat_test":   data.get("stattest_name", ""),
                        "threshold":   data.get("stattest_threshold", 0.05),
                    })
                # Sort drifted features first, then by score desc
                out["features"].sort(key=lambda f: (-int(f["drifted"]), -f["drift_score"]))

            elif "ClassificationQualityMetric" in mtype:
                cur = result.get("current", {})
                out["classification"] = {
                    "accuracy":  round(cur.get("accuracy",  0), 4),
                    "f1":        round(cur.get("f1",        0), 4),
                    "precision": round(cur.get("precision", 0), 4),
                    "recall":    round(cur.get("recall",    0), 4),
                }

    except Exception as e:
        out["parse_error"] = str(e)

    return out


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------

@router.get("/evidently/reports")
async def list_reports():
    """List all Evidently Cloud report snapshots for the project."""
    if not EVIDENTLY_API_KEY:
        return JSONResponse({"error": "EVIDENTLY_API_KEY not configured"}, status_code=503)
    try:
        loop      = asyncio.get_event_loop()
        snapshots = await loop.run_in_executor(None, _list_snapshots_sync)
        return {"project_id": EVIDENTLY_PROJECT_ID, "snapshots": snapshots}
    except Exception as e:
        return JSONResponse({"error": str(e)}, status_code=502)


@router.get("/evidently/latest")
async def latest_report():
    """Return drift + classification metrics from the most recent snapshot."""
    if not EVIDENTLY_API_KEY:
        return JSONResponse({"error": "EVIDENTLY_API_KEY not configured"}, status_code=503)
    try:
        loop   = asyncio.get_event_loop()
        result = await loop.run_in_executor(None, _load_latest_sync)
        if result is None:
            return JSONResponse({"error": "No snapshots found in project"}, status_code=404)
        return result
    except Exception as e:
        return JSONResponse({"error": str(e)}, status_code=502)
