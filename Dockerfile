# Use Node.js as the base image
FROM node:18-slim

# Install Python and other dependencies
RUN apt-get update && apt-get install -y \
    python3 \
    python3-pip \
    python3-venv \
    curl \
    procps \
    && rm -rf /var/lib/apt/lists/*

# Set the working directory
WORKDIR /app

# Copy package.json and package-lock.json
COPY package*.json ./

# Install Node.js dependencies
RUN npm install

# Copy requirements.txt
COPY requirements.txt ./

# Create a virtual environment and install Python dependencies
RUN python3 -m venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH"
RUN pip install --no-cache-dir -r requirements.txt

# Copy the rest of the application code
COPY . .

# Create output directories
RUN mkdir -p Scripts/outputs/{GetTask,GetOrderInquiry,Funeral_Finder,Updater,ClosingTask} \
    && mkdir -p backend/data

# Make entrypoint executable
RUN chmod +x docker-entrypoint.sh

# Expose ports for frontend (8080) and backend (8787)
EXPOSE 8080 8787

# Use the entrypoint script
ENTRYPOINT ["/app/docker-entrypoint.sh"]
