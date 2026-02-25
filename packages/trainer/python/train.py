#!/usr/bin/env python3
"""
The Forge — LoRA Training
Runs MLX LoRA fine-tuning on prepared data. Domain-aware: uses domain config
for base model, data paths, and training defaults.

Usage:
    python scripts/train.py [--domain coding] [--iters 500]
    python scripts/train.py --domain tools --no-resume
"""

import json
import os
import sys
import time
import argparse
import subprocess
import tempfile
from pathlib import Path
from domain_config import get_active_domain, load_domain

TRAINER_DIR = Path(__file__).resolve().parent.parent

# These are set in main() from domain config
BASE_MODEL = None
ADAPTERS_DIR = None
DATA_DIR = None
TRAIN_FILE = None
VALID_FILE = None
DOMAIN = None


def get_next_version(adapters_dir):
    """Determine next version number from existing adapters."""
    if not adapters_dir.exists():
        adapters_dir.mkdir(parents=True)
        return 1

    versions = []
    for d in adapters_dir.iterdir():
        if d.is_dir() and d.name.startswith("v"):
            try:
                versions.append(int(d.name[1:]))
            except ValueError:
                continue
    return max(versions, default=0) + 1


def get_previous_adapter(version, adapters_dir):
    """Get the adapter path from the previous version (for resume)."""
    prev = version - 1
    if prev < 1:
        return None
    prev_path = adapters_dir / f"v{prev}" / "adapters.safetensors"
    if prev_path.exists():
        return str(prev_path)
    return None


def count_lines(filepath):
    with open(filepath) as f:
        return sum(1 for _ in f)


def main():
    global BASE_MODEL, ADAPTERS_DIR, DATA_DIR, TRAIN_FILE, VALID_FILE, DOMAIN

    parser = argparse.ArgumentParser(description="Run LoRA training on prepared data")
    parser.add_argument("--domain", type=str, default=None, help="Domain to train (default: active domain)")
    parser.add_argument("--iters", type=int, default=None, help="Training iterations (default: from domain config)")
    parser.add_argument("--batch-size", type=int, default=None, help="Batch size (default: from domain config)")
    parser.add_argument("--lr", type=float, default=None, help="Learning rate (default: from domain config)")
    parser.add_argument("--num-layers", type=int, default=None, help="LoRA layers (default: from domain config)")
    parser.add_argument("--lora-rank", type=int, default=16, help="LoRA rank (default: 16)")
    parser.add_argument("--lora-alpha", type=float, default=32, help="LoRA alpha (default: 32, typically 2x rank)")
    parser.add_argument("--max-seq-length", type=int, default=None, help="Max sequence length (default: from domain config)")
    parser.add_argument("--no-mask-prompt", action="store_true", help="Disable prompt masking (default: mask enabled)")
    parser.add_argument("--no-resume", action="store_true", help="Don't resume from previous adapter (use for rank changes)")
    parser.add_argument("--version", type=int, default=None, help="Override version number")
    args = parser.parse_args()

    # Load domain config
    if args.domain:
        DOMAIN = load_domain(args.domain)
    else:
        DOMAIN = get_active_domain()

    domain_id = DOMAIN["id"]
    training_cfg = DOMAIN.get("training", {})

    # Resolve defaults from domain config, CLI args override
    iters = args.iters or training_cfg.get("default_iters", 600)
    batch_size = args.batch_size or training_cfg.get("default_batch_size", 1)
    lr = args.lr or training_cfg.get("default_lr", 1e-5)
    num_layers = args.num_layers or training_cfg.get("default_lora_layers", 16)
    max_seq = args.max_seq_length or training_cfg.get("default_max_seq", 4096)

    # Domain-specific paths
    base_model_name = DOMAIN.get("base_model", "Qwen2.5-Coder-7B-Instruct-4bit")
    BASE_MODEL = TRAINER_DIR / "models" / "base" / base_model_name

    if domain_id == "coding":
        # Backward compat: coding uses root dirs
        ADAPTERS_DIR = TRAINER_DIR / "models" / "adapters"
        DATA_DIR = TRAINER_DIR / "data"
    else:
        ADAPTERS_DIR = TRAINER_DIR / "models" / "adapters" / domain_id
        DATA_DIR = TRAINER_DIR / "data" / domain_id

    TRAIN_FILE = DATA_DIR / "train.jsonl"
    VALID_FILE = DATA_DIR / "valid.jsonl"

    # Validate inputs
    if not BASE_MODEL.exists():
        print(f"Base model not found at {BASE_MODEL}")
        print(f"Download it first: huggingface-cli download {DOMAIN.get('base_model_hf', base_model_name)}")
        sys.exit(1)

    if not TRAIN_FILE.exists():
        print(f"Training data not found at {TRAIN_FILE}")
        print(f"Run: python scripts/prepare-data.py --domain {domain_id}")
        sys.exit(1)

    train_count = count_lines(TRAIN_FILE)
    valid_count = count_lines(VALID_FILE) if VALID_FILE.exists() else 0

    version = args.version or get_next_version(ADAPTERS_DIR)
    adapter_path = ADAPTERS_DIR / f"v{version}"
    adapter_path.mkdir(parents=True, exist_ok=True)

    model_prefix = DOMAIN.get("model_prefix", "engie-coder")

    print(f"=== The Forge — Training {model_prefix} v{version} ===")
    print(f"  Domain:       {DOMAIN['name']} ({domain_id})")
    print(f"  Base model:   {BASE_MODEL}")
    print(f"  Train data:   {train_count} examples")
    print(f"  Valid data:   {valid_count} examples")
    print(f"  Iterations:   {iters}")
    print(f"  Batch size:   {batch_size}")
    print(f"  Learning rate: {lr}")
    print(f"  LoRA layers:  {num_layers}")
    print(f"  LoRA rank:    {args.lora_rank}")
    print(f"  LoRA alpha:   {args.lora_alpha}")
    print(f"  Max seq len:  {max_seq}")
    print(f"  Mask prompt:  {not args.no_mask_prompt}")
    print(f"  Adapter path: {adapter_path}")

    # Write LoRA config YAML
    lora_config = {
        "lora_parameters": {
            "rank": args.lora_rank,
            "alpha": args.lora_alpha,
            "dropout": 0.05,
            "scale": args.lora_alpha / args.lora_rank,
        }
    }
    config_path = adapter_path / "lora-config.yaml"
    import yaml_compat
    yaml_compat.write(config_path, lora_config)

    # Build mlx_lm.lora command
    cmd = [
        sys.executable, "-m", "mlx_lm", "lora",
        "--model", str(BASE_MODEL),
        "--data", str(DATA_DIR),
        "--train",
        "--iters", str(iters),
        "--batch-size", str(batch_size),
        "--num-layers", str(num_layers),
        "--learning-rate", str(lr),
        "--adapter-path", str(adapter_path),
        "--max-seq-length", str(max_seq),
        "--grad-checkpoint",
        "--val-batches", "4",
        "--steps-per-eval", "50",
        "--steps-per-report", "10",
        "--save-every", "100",
        "-c", str(config_path),
    ]

    if not args.no_mask_prompt:
        cmd.append("--mask-prompt")

    # Resume from previous adapter if available
    prev_adapter = None if args.no_resume else get_previous_adapter(version, ADAPTERS_DIR)
    if prev_adapter:
        cmd.extend(["--resume-adapter-file", prev_adapter])
        print(f"  Resuming from: {prev_adapter}")

    # Metal GPU memory guards
    metal_env = os.environ.copy()
    metal_env["MLX_METAL_PREALLOCATE"] = "0"
    metal_env["MLX_METAL_MEMORY_BUDGET"] = str(6 * 1024 * 1024 * 1024)  # 6GB

    # Stop Ollama to free GPU VRAM — critical for Metal training
    ollama_was_running = False
    try:
        check = subprocess.run(["pgrep", "-x", "ollama"], capture_output=True)
        ollama_was_running = check.returncode == 0
    except Exception:
        pass

    if ollama_was_running:
        print("\nStopping Ollama to free GPU VRAM...")
        subprocess.run(["brew", "services", "stop", "ollama"], capture_output=True)
        time.sleep(3)  # wait for VRAM release

    print(f"\nStarting training...")
    print(f"  Metal guards: PREALLOCATE=0, MEMORY_BUDGET=6GB")
    if ollama_was_running:
        print(f"  Ollama stopped (will restart after training)")
    start = time.time()

    max_attempts = 2
    for attempt in range(1, max_attempts + 1):
        try:
            result = subprocess.run(
                cmd,
                cwd=str(TRAINER_DIR),
                env=metal_env,
                check=True,
                text=True,
                capture_output=False,
            )
            break
        except subprocess.CalledProcessError as e:
            duration = time.time() - start
            is_metal_crash = e.returncode < 0 or e.returncode == 134

            if is_metal_crash and attempt < max_attempts:
                print(f"\nMetal GPU crash detected (exit code {e.returncode}), retrying ({attempt}/{max_attempts})...")
                print(f"  Tip: try --max-seq-length 2048 if this keeps happening.")
                time.sleep(3)
                start = time.time()
                continue

            print(f"\nTraining FAILED after {duration:.1f}s (exit code {e.returncode})")
            if is_metal_crash:
                print(f"  Metal GPU crash — try reducing --max-seq-length or --batch-size")

            try:
                _record_run(version, domain_id, model_prefix, train_count, valid_count, None, None, iters, duration, "failed")
            except Exception:
                pass

            if ollama_was_running:
                print("Restarting Ollama...")
                subprocess.run(["brew", "services", "start", "ollama"], capture_output=True)

            sys.exit(1)

    duration = time.time() - start
    print(f"\nTraining completed in {duration:.1f}s")

    # Extract loss from adapter config
    train_loss = None
    valid_loss = None
    adapter_config = adapter_path / "adapter_config.json"
    if adapter_config.exists():
        try:
            config = json.loads(adapter_config.read_text())
            train_loss = config.get("train_loss")
            valid_loss = config.get("val_loss")
        except Exception:
            pass

    # Record in forge DB
    try:
        _record_run(version, domain_id, model_prefix, train_count, valid_count, train_loss, valid_loss, iters, duration, "completed")
    except Exception as e:
        print(f"Warning: Could not record run in DB: {e}")

    # Save training metadata
    meta = {
        "version": f"v{version}",
        "domain": domain_id,
        "model_prefix": model_prefix,
        "base_model": str(BASE_MODEL),
        "train_examples": train_count,
        "valid_examples": valid_count,
        "iterations": iters,
        "batch_size": batch_size,
        "learning_rate": lr,
        "num_layers": num_layers,
        "lora_rank": args.lora_rank,
        "lora_alpha": args.lora_alpha,
        "max_seq_length": max_seq,
        "mask_prompt": not args.no_mask_prompt,
        "duration_seconds": round(duration, 1),
        "train_loss": train_loss,
        "valid_loss": valid_loss,
        "previous_adapter": prev_adapter,
    }
    meta_path = adapter_path / "training-meta.json"
    meta_path.write_text(json.dumps(meta, indent=2))
    print(f"  Metadata saved to {meta_path}")

    # Restart Ollama if we stopped it
    if ollama_was_running:
        print("Restarting Ollama...")
        subprocess.run(["brew", "services", "start", "ollama"], capture_output=True)

    print(f"\nAdapter saved at: {adapter_path}")
    print(f"Next: python scripts/evaluate.py --domain {domain_id}")
    print(f"Then: python scripts/fuse-and-deploy.py --domain {domain_id}")


def _record_run(version, domain_id, model_prefix, train_count, valid_count, train_loss, valid_loss, iters, duration, status):
    """Record training run in the forge SQLite DB via Bun subprocess."""
    version_tag = f"{model_prefix}-v{version}" if domain_id != "coding" else f"v{version}"
    adapter_path = ADAPTERS_DIR / f"v{version}" if ADAPTERS_DIR else f"models/adapters/v{version}"
    js = f"""
    import {{ startRun, completeRun, failRun, createVersion }} from "{TRAINER_DIR}/forge-db.js";
    const v = "{version_tag}";
    try {{ createVersion(v, {{ adapterPath: "{adapter_path}", notes: "domain={domain_id}" }}); }} catch {{}}
    startRun(v, {train_count}, {valid_count});
    if ("{status}" === "completed") {{
      completeRun(v, {{
        trainLoss: {train_loss if train_loss else 'null'},
        validLoss: {valid_loss if valid_loss else 'null'},
        iterations: {iters},
        durationSeconds: {round(duration, 1)},
      }});
    }} else {{
      failRun(v);
    }}
    """
    try:
        subprocess.run(["bun", "-e", js], capture_output=True, timeout=10)
    except Exception:
        pass


if __name__ == "__main__":
    main()
