import pandas as pd
import numpy as np
import os

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

out = os.path.join(os.path.dirname(__file__), "lab_results.csv")
df.to_csv(out, index=False)
print(f"Generated {len(df)} records → {out}")
