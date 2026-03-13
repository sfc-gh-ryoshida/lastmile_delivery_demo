#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
IMAGE_NAME="osrm-kanto"
IMAGE_TAG="latest"

echo "=== Building OSRM image (kanto region) ==="
echo "This downloads ~1.6GB OSM data and processes it. Takes 10-20 minutes."

docker build -t "${IMAGE_NAME}:${IMAGE_TAG}" "${SCRIPT_DIR}"

echo ""
echo "=== Build complete ==="
echo "Run locally:  docker run -d --name osrm -p 5000:5000 ${IMAGE_NAME}:${IMAGE_TAG}"
echo "Test:         curl 'http://localhost:5000/table/v1/driving/139.79,35.64;139.80,35.65?annotations=duration,distance'"
echo ""
echo "=== For SPCS deployment ==="
echo "Tag & push to Snowflake image registry:"
echo "  docker tag ${IMAGE_NAME}:${IMAGE_TAG} <registry>/lastmile_db/spcs/lastmile_repo/osrm-kanto:${IMAGE_TAG}"
echo "  docker push <registry>/lastmile_db/spcs/lastmile_repo/osrm-kanto:${IMAGE_TAG}"
