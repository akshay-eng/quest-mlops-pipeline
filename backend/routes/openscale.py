"""
Watson OpenScale (IBM Watson AI Fairness) — Model Monitoring routes.

Endpoints:
  GET /api/openscale/deployments          — all subscriptions with monitor status
  GET /api/openscale/deployments/{sub_id} — single subscription detail + last run metrics
  POST /api/openscale/deployments/{sub_id}/investigate — trigger Watson X Orchestrate agent
"""

import os
import time
import asyncio
import httpx
from fastapi import APIRouter, HTTPException
from functools import lru_cache

router = APIRouter()

IBM_API_KEY   = os.environ.get("IBM_API_KEY", "")
INSTANCE_ID   = os.environ.get("OPENSCALE_INSTANCE_ID", "c6614aae-7f6f-4a92-ab36-0c432f433dc2")
ORCHESTRATE_WEBHOOK = os.environ.get("WATSONX_ORCHESTRATE_WEBHOOK_URL", "")

OS_BASE = f"https://aiopenscale.cloud.ibm.com/openscale/{INSTANCE_ID}/v2"

# --------------------------------------------------------------------------
# Monitor definitions we surface in the UI
# --------------------------------------------------------------------------
MONITOR_LABELS = {
    "quality":       "Quality",
    "fairness":      "Fairness",
    "drift_v2":      "Drift v2",
    "explainability": "Explainability",
}

# --------------------------------------------------------------------------
# IAM token cache  (tokens expire after ~1 hour; cache for 55 min)
# --------------------------------------------------------------------------
_token_cache: dict = {"token": None, "expires_at": 0}


async def _get_iam_token() -> str:
    now = time.time()
    if _token_cache["token"] and now < _token_cache["expires_at"]:
        return _token_cache["token"]

    if not IBM_API_KEY:
        raise HTTPException(status_code=503, detail="IBM_API_KEY env var not set")

    async with httpx.AsyncClient(timeout=15) as client:
        resp = await client.post(
            "https://iam.cloud.ibm.com/identity/token",
            data={
                "grant_type": "urn:ibm:params:oauth:grant-type:apikey",
                "apikey":     IBM_API_KEY,
            },
            headers={"Content-Type": "application/x-www-form-urlencoded"},
        )

    if resp.status_code != 200:
        raise HTTPException(status_code=502, detail=f"IAM token error: {resp.text[:200]}")

    data = resp.json()
    _token_cache["token"]      = data["access_token"]
    _token_cache["expires_at"] = now + int(data.get("expires_in", 3600)) - 300
    return _token_cache["token"]


async def _os_get(path: str, token: str) -> dict:
    async with httpx.AsyncClient(timeout=20) as client:
        resp = await client.get(
            f"{OS_BASE}{path}",
            headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
        )
    if resp.status_code != 200:
        return {}
    return resp.json()


# --------------------------------------------------------------------------
# Helpers to build deployment card data
# --------------------------------------------------------------------------
def _run_state_to_ui(state: str | None) -> str:
    """Map OpenScale run state to a UI-friendly string."""
    if not state:         return "unknown"
    if state == "finished": return "ok"
    if state == "error":    return "error"
    if state == "running":  return "running"
    return state


def _build_monitor_summary(monitor_instances: list) -> dict:
    """Extract per-monitor last-run state from monitor_instances list."""
    summary = {}
    for mi in monitor_instances:
        ent = mi.get("entity", {})
        mon_id = ent.get("monitor_definition_id", "")
        if mon_id not in MONITOR_LABELS:
            continue
        params     = ent.get("parameters", {})
        last_state = params.get("last_run_status", None)
        # Normalise: FINISHED → ok, ERROR → error, FINISHED_WITHOUT_METRICS → warning
        if last_state:
            last_state = last_state.lower()
            if "finished_without" in last_state: last_state = "warning"
            elif "finished" in last_state:        last_state = "ok"
            elif "error" in last_state:           last_state = "error"

        summary[mon_id] = {
            "label":       MONITOR_LABELS[mon_id],
            "state":       last_state or "unknown",
            "instance_id": mi["metadata"]["id"],
        }
    return summary


async def _get_latest_run(token: str, instance_id: str) -> dict | None:
    """Fetch the most recent run for a monitor instance."""
    data = await _os_get(f"/monitor_instances/{instance_id}/runs?limit=1", token)
    runs = data.get("runs", [])
    if not runs:
        return None
    run    = runs[0]
    status = run.get("entity", {}).get("status", {})
    return {
        "state":        status.get("state"),
        "completed_at": status.get("completed_at"),
        "error":        status.get("failure", {}).get("errors", [{}])[0].get("message") if status.get("failure") else None,
    }


# --------------------------------------------------------------------------
# GET /api/openscale/deployments
# --------------------------------------------------------------------------
@router.get("/openscale/deployments")
async def list_deployments():
    """Return all OpenScale subscriptions with monitor health summary."""
    token = await _get_iam_token()

    subs_data  = await _os_get("/subscriptions", token)
    subs       = subs_data.get("subscriptions", [])

    # Fetch monitor instances for all subs concurrently
    async def _enrich(sub: dict) -> dict:
        sub_id = sub["metadata"]["id"]
        ent    = sub.get("entity", {})
        asset  = ent.get("asset", {})
        dep    = ent.get("deployment", {})
        risk   = ent.get("risk_evaluation_status", {})

        mi_data = await _os_get(
            f"/monitor_instances?target.target_id={sub_id}&target.target_type=subscription",
            token,
        )
        monitors = _build_monitor_summary(mi_data.get("monitor_instances", []))

        # Determine last evaluated time across all monitors
        timestamps = [
            mi.get("metadata", {}).get("modified_at", "")
            for mi in mi_data.get("monitor_instances", [])
            if mi.get("metadata", {}).get("modified_at")
        ]
        last_evaluated = max(timestamps) if timestamps else None

        # Overall status: any error → alert, all ok → ok, else warning
        states = [m["state"] for m in monitors.values()]
        if "error" in states:      overall = "alert"
        elif "warning" in states:  overall = "warning"
        elif all(s == "ok" for s in states if s != "unknown"): overall = "ok"
        else:                      overall = "unknown"

        return {
            "id":             sub_id,
            "name":           asset.get("name", dep.get("name", "Unknown")),
            "deployment_name": dep.get("name", ""),
            "deployment_type": dep.get("deployment_type", "online"),
            "problem_type":   asset.get("problem_type", ""),
            "status":         ent.get("status", {}).get("state", ""),
            "approved":       risk.get("state") == "approved",
            "last_evaluated": last_evaluated,
            "overall_status": overall,
            "monitors":       monitors,
            "openscale_url":  f"https://aiopenscale.cloud.ibm.com/aiopenscale/insights",
        }

    results = await asyncio.gather(*[_enrich(s) for s in subs])
    return list(results)


# --------------------------------------------------------------------------
# GET /api/openscale/deployments/{sub_id}
# --------------------------------------------------------------------------
@router.get("/openscale/deployments/{sub_id}")
async def get_deployment(sub_id: str):
    """Return one subscription with latest run details per monitor."""
    token = await _get_iam_token()

    sub_data = await _os_get(f"/subscriptions/{sub_id}", token)
    if not sub_data:
        raise HTTPException(status_code=404, detail="Subscription not found")

    mi_data  = await _os_get(
        f"/monitor_instances?target.target_id={sub_id}&target.target_type=subscription",
        token,
    )
    monitor_instances = mi_data.get("monitor_instances", [])
    monitors = _build_monitor_summary(monitor_instances)

    # Fetch latest run for each tracked monitor
    async def _with_run(mon_id: str, info: dict) -> tuple[str, dict]:
        run = await _get_latest_run(token, info["instance_id"])
        return mon_id, {**info, "last_run": run}

    enriched = await asyncio.gather(*[
        _with_run(k, v) for k, v in monitors.items()
    ])
    monitors_detail = dict(enriched)

    ent   = sub_data.get("entity", {})
    asset = ent.get("asset", {})
    dep   = ent.get("deployment", {})

    return {
        "id":             sub_id,
        "name":           asset.get("name", ""),
        "deployment_name": dep.get("name", ""),
        "problem_type":   asset.get("problem_type", ""),
        "monitors":       monitors_detail,
    }
