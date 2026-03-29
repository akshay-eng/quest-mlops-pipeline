"""
Train a minimal drug-test classifier on synthetic data.
Runs during Docker image build so the model is baked into the image.
Saves: model/drug_test_classifier.pkl
       data/reference.jsonl  (Evidently reference distribution)
"""

import os
import json
import numpy as np
from sklearn.ensemble import RandomForestClassifier
import joblib

os.makedirs("model", exist_ok=True)
os.makedirs("data",  exist_ok=True)

np.random.seed(42)
N = 1000

age             = np.random.randint(18, 65, N).astype(float)
test_type_code  = np.random.randint(1, 8, N).astype(float)
collection_hour = np.random.randint(6, 18, N).astype(float)
days_since_hire = np.random.randint(30, 3650, N).astype(float)
panel_size      = np.random.randint(5, 20, N).astype(float)
specimen_type   = np.random.randint(0, 3, N).astype(float)

X = np.column_stack([age, test_type_code, collection_hour,
                     days_since_hire, panel_size, specimen_type])

# Synthetic label: younger employees, late collection, specimen_type=2 → positive
y = ((age < 28) & (collection_hour >= 15) | (specimen_type == 2)).astype(int)

clf = RandomForestClassifier(n_estimators=100, max_depth=6, random_state=42)
clf.fit(X, y)

joblib.dump(clf, "model/drug_test_classifier.pkl")
print("[train] Saved model/drug_test_classifier.pkl")

# Save reference distribution for Evidently drift baseline
predictions = clf.predict(X)
probas      = clf.predict_proba(X)[:, 1]

feature_names = ["age", "test_type_code", "collection_hour",
                 "days_since_hire", "panel_size", "specimen_type"]

with open("data/reference.jsonl", "w") as f:
    for i in range(N):
        record = {name: float(X[i, j]) for j, name in enumerate(feature_names)}
        record["target"]           = int(y[i])
        record["prediction"]       = int(predictions[i])
        record["prediction_proba"] = round(float(probas[i]), 4)
        f.write(json.dumps(record) + "\n")

print(f"[train] Saved data/reference.jsonl  ({N} rows)")
