#!/bin/bash
set -e

echo "=== BlossomTask Docker Entrypoint ==="

# Ensure output directories exist
mkdir -p /app/Scripts/outputs/{GetTask,GetOrderInquiry,Funeral_Finder,Updater,ClosingTask}
mkdir -p /app/backend/data

# Start backend server in background
echo "Starting backend server on port 8787..."
node /app/backend/server.js &
BACKEND_PID=$!

# Wait for backend to be ready
echo "Waiting for backend..."
for i in $(seq 1 30); do
  if curl -s http://localhost:8787/api/health > /dev/null 2>&1; then
    echo "Backend is ready!"
    break
  fi
  sleep 1
done

# Start frontend dev server in foreground
echo "Starting frontend dev server on port 8080..."
npx vite --host 0.0.0.0 --port 8080 &
FRONTEND_PID=$!

echo ""
echo "========================================="
echo "  BlossomTask is running!"
echo "  Frontend: http://localhost:8080"
echo "  Backend:  http://localhost:8787"
echo "========================================="
echo ""

# Graceful shutdown handler
cleanup() {
  echo "Shutting down..."
  kill $FRONTEND_PID 2>/dev/null || true
  kill $BACKEND_PID 2>/dev/null || true
  wait $FRONTEND_PID 2>/dev/null || true
  wait $BACKEND_PID 2>/dev/null || true
  echo "Shutdown complete."
  exit 0
}

trap cleanup SIGTERM SIGINT SIGQUIT

# Wait for either process to exit
wait -n $BACKEND_PID $FRONTEND_PID

# If one process exits, clean up the other
echo "A process exited, shutting down..."
cleanup
