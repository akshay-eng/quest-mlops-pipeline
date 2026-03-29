import os
import json
from datetime import datetime, timezone

import joblib
from fastapi import FastAPI, HTTPException

app = FastAPI(title="Quest Drug Test Classifier", version="1.0.0")

MODEL_PATH = os.environ.get("MODEL_PATH", "model/drug_test_classifier.pkl")
LOG_PATH   = os.environ.get("LOG_PATH",   "/data/predictions.jsonl")

model = None
FEATURE_NAMES = ["age", "test_type_code", "collection_hour",
                 "days_since_hire", "panel_size", "specimen_type"]


@app.on_event("startup")
def load_model():
    global model
    if os.path.exists(MODEL_PATH):
        model = joblib.load(MODEL_PATH)
        print(f"[serving] Model loaded from {MODEL_PATH}")
    else:
        print(f"[serving] WARNING: model not found at {MODEL_PATH}")


@app.get("/health")
def health():
    return {"status": "ok", "model_loaded": model is not None}


@app.post("/predict")
def predict(features: dict):
    if model is None:
        raise HTTPException(status_code=503, detail="Model not loaded")

    values = [[
        features.get("age",             30.0),
        features.get("test_type_code",   1.0),
        features.get("collection_hour",  9.0),
        features.get("days_since_hire", 365.0),
        features.get("panel_size",      10.0),
        features.get("specimen_type",    0.0),
    ]]

    prediction = model.predict(values)[0]
    proba      = model.predict_proba(values)[0]

    result = {
        "prediction":  int(prediction),
        "label":       "positive" if prediction == 1 else "negative",
        "confidence":  round(float(max(proba)), 4),
    }

    # Log prediction for Evidently monitoring
    record = {"timestamp": datetime.now(timezone.utc).isoformat()}
    for name in FEATURE_NAMES:
        record[name] = features.get(name)
    record["prediction"]       = int(prediction)
    record["prediction_proba"] = round(float(proba[1]), 4)

    try:
        os.makedirs(os.path.dirname(LOG_PATH) or ".", exist_ok=True)
        with open(LOG_PATH, "a") as f:
            f.write(json.dumps(record) + "\n")
    except Exception as e:
        print(f"[serving] Log write failed: {e}")

    return result


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8080)
