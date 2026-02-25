#!/usr/bin/env bash
set -euo pipefail

# The Forge — Environment Setup
# Sets up Python venv, installs deps, creates directories, downloads base model.
#
# Usage:
#   bash ~/engie/trainer/setup.sh

TRAINER_DIR="$(cd "$(dirname "$0")" && pwd)"
PYTHON="/opt/homebrew/bin/python3"
VENV_DIR="$TRAINER_DIR/.venv"
BASE_MODEL_DIR="$TRAINER_DIR/models/base/Qwen2.5-Coder-7B-Instruct-4bit"

echo "=== The Forge — Setup ==="
echo "Trainer dir: $TRAINER_DIR"
echo ""

# 1. Check Python
if [ ! -x "$PYTHON" ]; then
  echo "ERROR: Python not found at $PYTHON"
  echo "Install with: brew install python@3.14"
  exit 1
fi

PYVER=$("$PYTHON" --version 2>&1)
echo "Python: $PYVER"

# 2. Create venv
if [ ! -d "$VENV_DIR" ]; then
  echo "Creating virtual environment at $VENV_DIR ..."
  "$PYTHON" -m venv "$VENV_DIR"
  echo "  Done."
else
  echo "Virtual environment already exists at $VENV_DIR"
fi

# Activate venv
source "$VENV_DIR/bin/activate"

# 3. Install/upgrade pip + deps
echo ""
echo "Installing dependencies..."
pip install --upgrade pip --quiet
pip install -r "$TRAINER_DIR/requirements.txt" --quiet
echo "  Done."

# Verify mlx-lm
MLX_LM_VER=$(python -c "import mlx_lm; print(mlx_lm.__version__)" 2>/dev/null || echo "NOT INSTALLED")
echo "mlx-lm version: $MLX_LM_VER"

# 4. Create directory structure
echo ""
echo "Creating directories..."
dirs=(
  "$TRAINER_DIR/data/raw"
  "$TRAINER_DIR/models/base"
  "$TRAINER_DIR/models/adapters"
  "$TRAINER_DIR/models/fused"
  "$TRAINER_DIR/models/gguf"
  "$TRAINER_DIR/scripts"
  "$TRAINER_DIR/benchmarks/results"
  "$TRAINER_DIR/db"
)
for d in "${dirs[@]}"; do
  mkdir -p "$d"
  echo "  $d"
done

# 5. Download base model (Qwen2.5-Coder-7B-Instruct 4-bit)
if [ -d "$BASE_MODEL_DIR" ] && [ -f "$BASE_MODEL_DIR/config.json" ]; then
  echo ""
  echo "Base model already downloaded at $BASE_MODEL_DIR"
else
  echo ""
  echo "Downloading Qwen2.5-Coder-7B-Instruct-4bit via mlx_lm.convert..."
  echo "This will take a few minutes (downloading ~4GB)..."
  python -m mlx_lm convert \
    --hf-path Qwen/Qwen2.5-Coder-7B-Instruct \
    --mlx-path "$BASE_MODEL_DIR" \
    -q
  echo "  Done."
fi

# 6. Create empty test.jsonl if it doesn't exist (fixed benchmark — never overwritten)
if [ ! -f "$TRAINER_DIR/data/test.jsonl" ]; then
  touch "$TRAINER_DIR/data/test.jsonl"
  echo "Created empty data/test.jsonl (will be populated by benchmarks)"
fi

echo ""
echo "=== Setup Complete ==="
echo "Base model: $BASE_MODEL_DIR"
echo "Venv:       $VENV_DIR"
echo "mlx-lm:     $MLX_LM_VER"
echo ""
echo "Next steps:"
echo "  1. Start collecting data: the proxy will auto-collect when both backends are healthy"
echo "  2. Run training: engie forge train"
echo "  3. Evaluate: engie forge eval"
