FROM python:3.11-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY obituary_worker_v2.py .
CMD ["python", "obituary_worker_v2.py", "daemon"]
