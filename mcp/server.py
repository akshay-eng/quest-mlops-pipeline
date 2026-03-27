"""
WINGS FastMCP Server — GitHub + AWX Tower + VM tools for Quest MLOps POC

Tools exposed to the WXO agent:
  GitHub:
    - list_failed_workflow_runs   : get recent failed GH Actions runs
    - get_workflow_run_details    : jobs + steps for a specific run
    - get_workflow_run_logs       : failure log excerpt for root-cause
    - rerun_workflow              : re-trigger a failed run via GitHub API

  AWX Tower (Ansible):
    - list_awx_job_templates      : list available job templates in AWX
    - launch_awx_remediation_job  : launch the fix-milvus job template
    - get_awx_job_status          : poll a running AWX job for status + output

  VM:
    - check_milvus_health         : SSH health check on the inference VM

  Composite:
    - remediate_and_rerun         : full flow — check → AWX fix → verify → rerun

Run:
  pip install -r requirements.txt
  python server.py                        # stdio  (WXO MCP client)
  fastmcp run server.py --transport sse   # SSE    (HTTP-based clients)

Required env vars:
  GITHUB_TOKEN, GITHUB_OWNER, GITHUB_REPO
  AWX_URL            (e.g. http://52.118.209.108:30398)
  AWX_TOKEN          (Personal Access Token from AWX UI — preferred)
    OR AWX_USERNAME + AWX_PASSWORD  (basic auth fallback)
  AWX_JOB_TEMPLATE_ID  (numeric ID of the fix-milvus job template in AWX)
  IBM_VM_IP, IBM_VM_USER, IBM_VM_SSH_KEY_PATH
"""

import os
import asyncio
import subprocess
from pathlib import Path
from typing import Optional

from dotenv import load_dotenv
load_dotenv(Path(__file__).parent / ".env")

import httpx
from fastmcp import FastMCP

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------
GH_TOKEN  = os.environ.get("GITHUB_TOKEN", "")
GH_OWNER  = os.environ.get("GITHUB_OWNER", "")
GH_REPO   = os.environ.get("GITHUB_REPO", "")

AWX_URL              = os.environ.get("AWX_URL", "http://52.118.209.108:30398").rstrip("/")
AWX_TOKEN            = os.environ.get("AWX_TOKEN", "")          # preferred
AWX_USERNAME         = os.environ.get("AWX_USERNAME", "admin")  # basic-auth fallback
AWX_PASSWORD         = os.environ.get("AWX_PASSWORD", "")       # basic-auth fallback
AWX_JOB_TEMPLATE_ID  = os.environ.get("AWX_JOB_TEMPLATE_ID", "") # e.g. "5"

IBM_VM_IP           = os.environ.get("IBM_VM_IP", "")
IBM_VM_USER         = os.environ.get("IBM_VM_USER", "akshay")
IBM_VM_SSH_KEY_PATH = os.environ.get(
    "IBM_VM_SSH_KEY_PATH",
    str(Path(__file__).parent.parent / "milvuslinuxvmibmcloud_rsa.prv"),
)

GH_API = "https://api.github.com"
GH_HEADERS = {
    "Authorization": f"Bearer {GH_TOKEN}",
    "Accept": "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
}

# ---------------------------------------------------------------------------
# AWX auth helper — token takes priority, falls back to basic auth
# ---------------------------------------------------------------------------
def _awx_auth() -> dict:
    """Return httpx auth kwargs for AWX requests."""
    if AWX_TOKEN:
        return {"headers": {"Authorization": f"Bearer {AWX_TOKEN}", "Content-Type": "application/json"}}
    return {"auth": (AWX_USERNAME, AWX_PASSWORD), "headers": {"Content-Type": "application/json"}}


# ---------------------------------------------------------------------------
mcp = FastMCP(
    name="WINGS GitHub + AWX MCP",
    instructions=(
        "You are the WINGS remediation agent for Quest Diagnostics MLOps. "
        "Use these tools to detect GitHub Actions failures, diagnose root cause, "
        "launch Ansible remediation jobs via AWX Tower on the IBM Cloud inference VM, "
        "and re-trigger the pipeline once the fix is verified."
    ),
)


# ===========================================================================
# GITHUB TOOLS
# ===========================================================================

@mcp.tool()
async def list_failed_workflow_runs(
    workflow_file: str = "model-deploy-vm.yml",
    limit: int = 5,
) -> dict:
    """
    List the most recent failed GitHub Actions workflow runs.

    Args:
        workflow_file: Workflow filename e.g. 'model-deploy-vm.yml'.
                       Pass 'all' to query across all workflows.
        limit: Max runs to return (default 5).
    """
    async with httpx.AsyncClient(headers=GH_HEADERS, timeout=15) as client:
        if workflow_file == "all":
            url    = f"{GH_API}/repos/{GH_OWNER}/{GH_REPO}/actions/runs"
            params = {"status": "failure", "per_page": limit}
        else:
            url    = f"{GH_API}/repos/{GH_OWNER}/{GH_REPO}/actions/workflows/{workflow_file}/runs"
            params = {"status": "failure", "per_page": limit}

        resp = await client.get(url, params=params)
        resp.raise_for_status()
        data = resp.json()

    runs = data.get("workflow_runs", [])
    return {
        "total_failed": data.get("total_count", len(runs)),
        "runs": [
            {
                "id":         r["id"],
                "name":       r["name"],
                "run_number": r["run_number"],
                "branch":     r["head_branch"],
                "commit_sha": r["head_sha"][:7],
                "created_at": r["created_at"],
                "html_url":   r["html_url"],
            }
            for r in runs
        ],
    }


@mcp.tool()
async def get_workflow_run_details(run_id: int) -> dict:
    """
    Get jobs and steps for a specific GitHub Actions workflow run.
    Use this to understand which step failed and why.

    Args:
        run_id: The GitHub Actions run ID (from list_failed_workflow_runs).
    """
    async with httpx.AsyncClient(headers=GH_HEADERS, timeout=15) as client:
        run_resp  = await client.get(f"{GH_API}/repos/{GH_OWNER}/{GH_REPO}/actions/runs/{run_id}")
        jobs_resp = await client.get(f"{GH_API}/repos/{GH_OWNER}/{GH_REPO}/actions/runs/{run_id}/jobs")
        run_resp.raise_for_status()
        jobs_resp.raise_for_status()

    run  = run_resp.json()
    jobs = jobs_resp.json().get("jobs", [])

    failed_steps = [
        {"job": j["name"], "step": s["name"], "number": s["number"]}
        for j in jobs
        for s in j.get("steps", [])
        if s.get("conclusion") == "failure"
    ]

    return {
        "run_id":       run["id"],
        "run_number":   run["run_number"],
        "name":         run["name"],
        "status":       run["status"],
        "conclusion":   run["conclusion"],
        "branch":       run["head_branch"],
        "commit_sha":   run["head_sha"][:7],
        "created_at":   run["created_at"],
        "html_url":     run["html_url"],
        "failed_steps": failed_steps,
        "jobs": [
            {
                "id":         j["id"],
                "name":       j["name"],
                "status":     j["status"],
                "conclusion": j["conclusion"],
                "steps": [
                    {
                        "number":     s["number"],
                        "name":       s["name"],
                        "status":     s["status"],
                        "conclusion": s["conclusion"],
                    }
                    for s in j.get("steps", [])
                ],
            }
            for j in jobs
        ],
    }


@mcp.tool()
async def get_workflow_run_logs(run_id: int, max_lines: int = 60) -> dict:
    """
    Download the failure log for a workflow run and return the tail.

    Args:
        run_id:    The GitHub Actions run ID.
        max_lines: Lines from the end of the log to return (default 60).
    """
    async with httpx.AsyncClient(headers=GH_HEADERS, timeout=20, follow_redirects=True) as client:
        resp = await client.get(
            f"{GH_API}/repos/{GH_OWNER}/{GH_REPO}/actions/runs/{run_id}/logs"
        )
        if resp.status_code == 404:
            return {"error": "Logs not available (run may be too old or still in progress)"}
        resp.raise_for_status()
        log_text = resp.text

    lines       = log_text.splitlines()
    tail        = "\n".join(lines[-max_lines:])
    error_lines = [l for l in lines if any(k in l.lower() for k in
                   ["error", "fail", "unhealthy", "milvus", "timeout", "refused"])]

    return {
        "total_lines":     len(lines),
        "log_excerpt":     tail,
        "error_lines":     error_lines[-20:],
        "root_cause_hint": error_lines[-1] if error_lines else "No explicit error found in log",
    }


@mcp.tool()
async def rerun_workflow(run_id: int, failed_jobs_only: bool = True) -> dict:
    """
    Re-trigger a GitHub Actions workflow run after remediation.

    Args:
        run_id:           The run ID to re-run.
        failed_jobs_only: Only re-run failed jobs (faster, default True).
    """
    async with httpx.AsyncClient(headers=GH_HEADERS, timeout=15) as client:
        if failed_jobs_only:
            url = f"{GH_API}/repos/{GH_OWNER}/{GH_REPO}/actions/runs/{run_id}/rerun-failed-jobs"
        else:
            url = f"{GH_API}/repos/{GH_OWNER}/{GH_REPO}/actions/runs/{run_id}/rerun"

        resp = await client.post(url)
        if resp.status_code not in (200, 201):
            return {
                "success": False,
                "error":   f"GitHub API returned {resp.status_code}: {resp.text[:200]}",
            }

    return {
        "success":      True,
        "run_id":       run_id,
        "rerun_mode":   "failed_jobs_only" if failed_jobs_only else "full_rerun",
        "workflow_url": f"https://github.com/{GH_OWNER}/{GH_REPO}/actions/runs/{run_id}",
        "message":      "Workflow re-triggered. Monitor the dashboard for the new run status.",
    }


# ===========================================================================
# AWX TOWER TOOLS
# ===========================================================================

@mcp.tool()
async def list_awx_job_templates() -> dict:
    """
    List all available job templates in AWX Tower.
    Use this to find the correct template ID for the Milvus remediation job.
    """
    auth = _awx_auth()
    async with httpx.AsyncClient(timeout=15, verify=False, **auth) as client:
        resp = await client.get(f"{AWX_URL}/api/v2/job_templates/?page_size=50")
        if resp.status_code == 401:
            return {"error": "AWX authentication failed. Check AWX_TOKEN or AWX_USERNAME/AWX_PASSWORD."}
        resp.raise_for_status()
        data = resp.json()

    return {
        "count": data.get("count", 0),
        "templates": [
            {
                "id":          t["id"],
                "name":        t["name"],
                "description": t.get("description", ""),
                "playbook":    t.get("playbook", ""),
                "last_job_run": t.get("last_job_run", "never"),
                "status":      t.get("status", ""),
            }
            for t in data.get("results", [])
        ],
    }


@mcp.tool()
async def launch_awx_remediation_job(
    job_template_id: Optional[str] = None,
    extra_vars: Optional[dict] = None,
) -> dict:
    """
    Launch the Milvus fix job template in AWX Tower.
    AWX will SSH into the IBM Cloud VM and run the fix-milvus Ansible playbook.

    Args:
        job_template_id: AWX job template ID. Defaults to AWX_JOB_TEMPLATE_ID env var.
                         Use list_awx_job_templates() to find it.
        extra_vars:      Optional dict of extra Ansible variables to pass to the job.

    Returns:
        AWX job ID and URL to monitor progress.
    """
    template_id = job_template_id or AWX_JOB_TEMPLATE_ID
    if not template_id:
        return {
            "success": False,
            "error": (
                "AWX_JOB_TEMPLATE_ID not set. "
                "Run list_awx_job_templates() to find the template ID, "
                "then set AWX_JOB_TEMPLATE_ID env var or pass job_template_id."
            ),
        }

    payload = {}
    if extra_vars:
        import json
        payload["extra_vars"] = json.dumps(extra_vars)

    auth = _awx_auth()
    async with httpx.AsyncClient(timeout=20, verify=False, **auth) as client:
        resp = await client.post(
            f"{AWX_URL}/api/v2/job_templates/{template_id}/launch/",
            json=payload,
        )
        if resp.status_code == 401:
            return {"success": False, "error": "AWX authentication failed."}
        if resp.status_code == 404:
            return {"success": False, "error": f"Job template {template_id} not found in AWX."}
        if resp.status_code not in (200, 201):
            return {"success": False, "error": f"AWX returned {resp.status_code}: {resp.text[:300]}"}

        job = resp.json()

    job_id  = job.get("id")
    job_url = f"{AWX_URL}/#/jobs/playbook/{job_id}"

    return {
        "success":      True,
        "job_id":       job_id,
        "job_url":      job_url,
        "status":       job.get("status", "pending"),
        "template_id":  template_id,
        "message": (
            f"AWX job {job_id} launched. "
            f"Monitor at {job_url} or call get_awx_job_status(job_id={job_id})."
        ),
    }


@mcp.tool()
async def get_awx_job_status(job_id: int, include_output: bool = True) -> dict:
    """
    Get the current status and output of an AWX Tower job.

    Args:
        job_id:         The AWX job ID (from launch_awx_remediation_job).
        include_output: If True, return the last 50 lines of Ansible output.

    Returns:
        Job status, elapsed time, failed tasks, and log tail.
    """
    auth = _awx_auth()
    async with httpx.AsyncClient(timeout=15, verify=False, **auth) as client:
        job_resp = await client.get(f"{AWX_URL}/api/v2/jobs/{job_id}/")
        if job_resp.status_code == 404:
            return {"error": f"AWX job {job_id} not found."}
        job_resp.raise_for_status()
        job = job_resp.json()

        output_tail = ""
        if include_output:
            out_resp = await client.get(
                f"{AWX_URL}/api/v2/jobs/{job_id}/stdout/",
                params={"format": "txt"},
            )
            if out_resp.status_code == 200:
                lines       = out_resp.text.splitlines()
                output_tail = "\n".join(lines[-50:])

    status    = job.get("status", "unknown")
    succeeded = status == "successful"
    failed    = status == "failed"

    return {
        "job_id":        job_id,
        "status":        status,
        "succeeded":     succeeded,
        "failed":        failed,
        "elapsed":       job.get("elapsed", 0),
        "started":       job.get("started"),
        "finished":      job.get("finished"),
        "failed_tasks":  job.get("failed", 0),
        "job_url":       f"{AWX_URL}/#/jobs/playbook/{job_id}",
        "output_tail":   output_tail,
        "message": (
            "✅ Ansible job completed successfully — Milvus is running." if succeeded else
            "❌ Ansible job failed. Check output_tail for details."      if failed    else
            f"⏳ Job is {status}. Call again to check progress."
        ),
    }


@mcp.tool()
async def wait_for_awx_job(job_id: int, timeout_seconds: int = 120) -> dict:
    """
    Poll AWX until a job reaches a terminal state (successful/failed/canceled).
    Useful when you need the fix to be confirmed before re-triggering the pipeline.

    Args:
        job_id:          AWX job ID to wait for.
        timeout_seconds: Max seconds to wait (default 120).
    """
    interval = 8
    elapsed  = 0

    while elapsed < timeout_seconds:
        result = await get_awx_job_status(job_id, include_output=False)
        status = result.get("status", "unknown")

        if status in ("successful", "failed", "canceled", "error"):
            final = await get_awx_job_status(job_id, include_output=True)
            return {**final, "waited_seconds": elapsed}

        await asyncio.sleep(interval)
        elapsed += interval

    return {
        "job_id":         job_id,
        "status":         "timeout",
        "waited_seconds": elapsed,
        "message":        f"Job did not complete within {timeout_seconds}s. Check AWX UI.",
    }


# ===========================================================================
# VM HEALTH CHECK
# ===========================================================================

@mcp.tool()
async def check_milvus_health(vm_ip: Optional[str] = None) -> dict:
    """
    SSH into the IBM Cloud inference VM and check if Milvus is healthy.
    Call this before and after the Ansible fix to confirm state change.

    Args:
        vm_ip: VM IP address. Defaults to IBM_VM_IP env var.
    """
    ip   = vm_ip or IBM_VM_IP
    user = IBM_VM_USER
    key  = IBM_VM_SSH_KEY_PATH

    if not ip:
        return {"error": "IBM_VM_IP not configured"}

    def _ssh(cmd: str) -> str:
        result = subprocess.run(
            ["ssh", "-o", "StrictHostKeyChecking=no",
             "-o", "ConnectTimeout=10",
             "-i", key, f"{user}@{ip}", cmd],
            capture_output=True, text=True, timeout=20,
        )
        return result.stdout.strip()

    loop            = asyncio.get_event_loop()
    http_status     = await loop.run_in_executor(None, _ssh,
        "curl -s -o /dev/null -w '%{http_code}' http://localhost:9091/healthz 2>/dev/null || echo 000")
    container_state = await loop.run_in_executor(None, _ssh,
        "sudo docker inspect --format='{{.State.Status}}' milvus-standalone 2>/dev/null || echo not_found")

    healthy = http_status == "200"
    return {
        "vm_ip":           ip,
        "healthy":         healthy,
        "http_status":     http_status,
        "container_state": container_state,
        "message": (
            "✅ Milvus is healthy — model deployment can proceed."
            if healthy else
            "❌ Milvus is DOWN — launch AWX remediation job to fix."
        ),
    }


# ===========================================================================
# COMPOSITE — full remediation flow in one call
# ===========================================================================

@mcp.tool()
async def remediate_and_rerun(
    github_run_id: int,
    job_template_id: Optional[str] = None,
    vm_ip: Optional[str] = None,
) -> dict:
    """
    Full end-to-end remediation:
      1. Check Milvus health on IBM Cloud VM (confirm it's down)
      2. Launch AWX Tower job to run fix-milvus Ansible playbook
      3. Wait for AWX job to complete
      4. Verify Milvus is healthy again
      5. Re-trigger the failed GitHub Actions workflow

    Args:
        github_run_id:   The failed GitHub Actions run ID.
        job_template_id: AWX job template ID (defaults to AWX_JOB_TEMPLATE_ID env var).
        vm_ip:           VM IP override (defaults to IBM_VM_IP env var).
    """
    results = {"steps": {}}

    # 1. Pre-flight health check
    pre = await check_milvus_health(vm_ip)
    results["steps"]["1_pre_check"] = pre
    if pre.get("healthy"):
        results["steps"]["note"] = "Milvus was already healthy — skipping Ansible fix."
    else:
        # 2. Launch AWX job
        launch = await launch_awx_remediation_job(job_template_id=job_template_id)
        results["steps"]["2_awx_launch"] = launch
        if not launch.get("success"):
            return {**results, "outcome": "FAILED — could not launch AWX job"}

        # 3. Wait for AWX job
        wait = await wait_for_awx_job(launch["job_id"], timeout_seconds=180)
        results["steps"]["3_awx_wait"] = wait
        if not wait.get("succeeded"):
            return {**results, "outcome": f"FAILED — AWX job ended with status: {wait.get('status')}"}

        # 4. Post-fix health check
        post = await check_milvus_health(vm_ip)
        results["steps"]["4_post_check"] = post
        if not post.get("healthy"):
            return {**results, "outcome": "FAILED — Milvus still unhealthy after Ansible fix"}

    # 5. Re-trigger GitHub workflow
    rerun = await rerun_workflow(github_run_id, failed_jobs_only=True)
    results["steps"]["5_rerun"] = rerun

    results["outcome"] = (
        "✅ SUCCESS — Milvus fixed via AWX and GitHub Actions workflow re-triggered."
        if rerun.get("success") else
        "⚠️  Milvus fixed but GitHub workflow re-trigger failed."
    )
    return results


# ===========================================================================
# Entry point
# ===========================================================================
if __name__ == "__main__":
    mcp.run(transport="sse", host="0.0.0.0", port=8089)
