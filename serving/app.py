from fastapi import FastAPI, HTTPException
import joblib
import os

app = FastAPI(title="Quest Drug Test Classifier", version="1.0.0")

MODEL_PATH = os.environ.get("MODEL_PATH", "model/drug_test_classifier.pkl")
model      = None


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
        features.get("age",            30),
        features.get("test_type_code",  1),
        features.get("collection_hour", 9),
        features.get("days_since_hire", 365),
        features.get("panel_size",      10),
        features.get("specimen_type",   0),
    ]]
    prediction = model.predict(values)[0]
    proba      = model.predict_proba(values)[0]
    return {
        "prediction": int(prediction),
        "label":      "positive" if prediction == 1 else "negative",
        "confidence": round(float(max(proba)), 4),
    }


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8080)
