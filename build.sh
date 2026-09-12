#!/bin/bash
# Build script para Render
set -e

echo " Installing dependencies..."
pip install -r requirements.txt

echo " Creating data directory..."
mkdir -p var

echo " Build complete!"
