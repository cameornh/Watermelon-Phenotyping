# Use official Python image
FROM python:3.11-slim

# Set the working directory
WORKDIR /app

# Copy your requirements
COPY requirements.txt .

# Minimal libs for OpenCV / EasyOCR runtime on slim images
RUN apt-get update && apt-get install -y --no-install-recommends \
    libglib2.0-0 \
    libgomp1 \
    && rm -rf /var/lib/apt/lists/*

# Install dependencies (CPU-only PyTorch to save space)
RUN pip install --no-cache-dir -r requirements.txt

# Copy all your scripts and weights into the container
COPY . .

# Hugging Face requires Docker spaces to run on port 7860!
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "7860"]