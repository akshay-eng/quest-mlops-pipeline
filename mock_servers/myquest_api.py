"""
Mock MyQuest API — simulates Quest Diagnostics' internal lab results API.

Run:
    python mock_servers/myquest_api.py

Env vars:
    VALID_TOKEN     token that returns CSV data  (default: valid_demo_token_2026)
    DEMO_FAIL_MODE  set to "auth" to make all requests return 401
"""

from fastapi import FastAPI, Header, HTTPException
from fastapi.responses import FileResponse
import os
import pandas as pd
import numpy as np
import uvicorn

app = FastAPI(title="MyQuest API Mock", version="1.0.0")

VALID_TOKEN = os.environ.get("VALID_TOKEN", "valid_demo_token_2026")
FAIL_MODE   = os.environ.get("DEMO_FAIL_MODE", "none")
DATA_FILE   = os.path.join(os.path.dirname(__file__), "..", "data", "lab_results.csv")


def _ensure_data():
    os.makedirs(os.path.dirname(DATA_FILE), exist_ok=True)
    if not os.path.exists(DATA_FILE):
        np.random.seed(42)
        n = 2000
        df = pd.DataFrame({
            "age":             np.random.randint(18, 65, n),
            "test_type_code":  np.random.choice([1, 2, 3, 4], n),
            "collection_hour": np.random.randint(6, 20, n),
            "days_since_hire": np.random.randint(0, 3650, n),
            "panel_size":      np.random.choice([5, 10, 12], n),
            "specimen_type":   np.random.choice([0, 1], n),
            "result":          np.random.choice([0, 1], n, p=[0.85, 0.15]),
        })
        df.to_csv(DATA_FILE, index=False)
        print(f"[mock] Generated {n} records → {DATA_FILE}")


@app.get("/health")
def health():
    return {"status": "ok", "service": "myquest-api-mock", "fail_mode": FAIL_MODE}


@app.get("/api/v1/results")
def get_results(authorization: str = Header(...)):
    # Inject auth failure if DEMO_FAIL_MODE=auth
    if FAIL_MODE == "auth":
        raise HTTPException(status_code=401, detail="Unauthorized: token has expired")

    token = authorization.replace("Bearer ", "").strip()
    if token != VALID_TOKEN:
        raise HTTPException(status_code=401, detail="Unauthorized: invalid token")

    _ensure_data()
    return FileResponse(DATA_FILE, media_type="text/csv", filename="lab_results.csv")


@app.post("/api/v1/token/rotate")
def rotate_token():
    """Called by the WINGS agent after rotating the GitHub secret."""
    return {
        "token":      VALID_TOKEN,
        "expires_in": 2592000,
        "message":    "Token rotated successfully",
    }


if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=8003)
