FROM python:3.11-slim
WORKDIR /app

# Install all dependencies upfront
RUN pip install --no-cache-dir \
    fastapi uvicorn scikit-learn joblib numpy pandas \
    evidently python-dotenv

# Train model at build time → bakes model.pkl into the image
COPY src/train_simple.py ./train_simple.py
RUN python train_simple.py

# Copy model server and Evidently monitor
COPY serving/app.py .
COPY src/monitor_evidently.py .

EXPOSE 8080
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8080"]
