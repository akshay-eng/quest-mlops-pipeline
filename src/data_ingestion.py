"""Fetch lab results CSV from the MyQuest API."""
import requests
import os
import sys

MYQUEST_API_URL   = os.environ.get("MYQUEST_API_URL",   "http://localhost:8003")
MYQUEST_API_TOKEN = os.environ.get("MYQUEST_API_TOKEN", "")
OUTPUT_PATH       = os.environ.get("DATA_OUTPUT_PATH",  "data/lab_results.csv")

print("=== Quest MLOps — Data Ingestion ===")
print(f"Endpoint : {MYQUEST_API_URL}/api/v1/results")
print(f"Output   : {OUTPUT_PATH}")

if not MYQUEST_API_TOKEN:
    print("ERROR: MYQUEST_API_TOKEN is not set")
    sys.exit(1)

headers = {"Authorization": f"Bearer {MYQUEST_API_TOKEN}"}

try:
    response = requests.get(
        f"{MYQUEST_API_URL}/api/v1/results",
        headers=headers,
        timeout=30,
    )
    response.raise_for_status()
except requests.exceptions.HTTPError:
    print(f"ERROR: HTTP {response.status_code} — {response.text}")
    sys.exit(1)
except requests.exceptions.ConnectionError as e:
    print(f"ERROR: Cannot connect to MyQuest API — {e}")
    sys.exit(1)
except requests.exceptions.Timeout:
    print("ERROR: Request timed out after 30 seconds")
    sys.exit(1)

os.makedirs(os.path.dirname(OUTPUT_PATH) or ".", exist_ok=True)
with open(OUTPUT_PATH, "wb") as f:
    f.write(response.content)

import pandas as pd
df = pd.read_csv(OUTPUT_PATH)
print(f"Downloaded {len(df)} records")
print("=== Ingestion complete ===")
