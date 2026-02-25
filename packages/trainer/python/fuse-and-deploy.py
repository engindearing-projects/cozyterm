#!/usr/bin/env python3
"""
The Forge — Fuse Adapter & Deploy to Ollama
Fuses LoRA adapter with base model, converts to GGUF Q4_K_M, creates Ollama model.

Pipeline: MLX fuse (dequantize) → convert_hf_to_gguf.py → llama-quantize Q4_K_M → ollama create

Usage:
    python scripts/fuse-and-deploy.py [--version v1] [--quant Q4_K_M]
"""

import json
import os
import sys
import time
import shutil
import argparse
import subprocess
from pathlib import Path
from domain_config import get_active_domain, load_domain

TRAINER_DIR = Path(__file__).resolve().parent.parent

# Set from domain config in main()
DOMAIN = None
BASE_MODEL = None
ADAPTERS_DIR = None
FUSED_DIR = TRAINER_DIR / "models" / "fused"
GGUF_DIR = TRAINER_DIR / "models" / "gguf"
PYTHON = sys.executable

# llama.cpp tools
CONVERT_SCRIPT = TRAINER_DIR / "tools" / "llama.cpp" / "convert_hf_to_gguf.py"
LLAMA_QUANTIZE = shutil.which("llama-quantize") or "/opt/homebrew/bin/llama-quantize"


def get_latest_version(adapters_dir):
    """Find the latest adapter version."""
    if not adapters_dir.exists():
        return None
    versions = []
    for d in adapters_dir.iterdir():
        if d.is_dir() and d.name.startswith("v"):
            try:
                versions.append(int(d.name[1:]))
            except ValueError:
                continue
    if not versions:
        return None
    return f"v{max(versions)}"


def main():
    global DOMAIN, BASE_MODEL, ADAPTERS_DIR

    parser = argparse.ArgumentParser(description="Fuse LoRA adapter and deploy to Ollama")
    parser.add_argument("--version", default=None, help="Version to fuse (default: latest)")
    parser.add_argument("--skip-ollama", action="store_true", help="Skip Ollama deployment")
    parser.add_argument("--quant", default="Q4_K_M", help="GGUF quantization type (default: Q4_K_M)")
    parser.add_argument("--skip-gguf", action="store_true", help="Skip GGUF conversion, deploy from safetensors")
    parser.add_argument("--domain", default=None, help="Domain to deploy (default: active domain)")
    args = parser.parse_args()

    # Load domain config
    if args.domain:
        DOMAIN = load_domain(args.domain)
    else:
        DOMAIN = get_active_domain()

    domain_id = DOMAIN["id"]

    # Set base model from domain config
    base_model_name = DOMAIN.get("base_model", "Qwen2.5-Coder-7B-Instruct-4bit")
    BASE_MODEL = TRAINER_DIR / "models" / "base" / base_model_name

    # Domain-specific adapter paths
    if domain_id == "coding":
        ADAPTERS_DIR = TRAINER_DIR / "models" / "adapters"
    else:
        ADAPTERS_DIR = TRAINER_DIR / "models" / "adapters" / domain_id

    version = args.version or get_latest_version(ADAPTERS_DIR)
    if not version:
        print("No adapter versions found. Run training first.")
        sys.exit(1)

    adapter_path = ADAPTERS_DIR / version
    if not adapter_path.exists():
        print(f"Adapter not found: {adapter_path}")
        sys.exit(1)

    fused_path = FUSED_DIR / version
    GGUF_DIR.mkdir(parents=True, exist_ok=True)
    model_prefix = DOMAIN.get("model_prefix", "engie-coder")
    gguf_f16 = GGUF_DIR / f"{model_prefix}-{version}-f16.gguf"
    gguf_quant = GGUF_DIR / f"{model_prefix}-{version}-{args.quant}.gguf"

    print(f"=== The Forge — Fuse & Deploy {version} ===")
    print(f"  Base model:   {BASE_MODEL}")
    print(f"  Adapter:      {adapter_path}")
    print(f"  Fused output: {fused_path}")
    print(f"  GGUF quant:   {args.quant}")

    # Step 1: Fuse adapter with base model (dequantize for GGUF conversion)
    print(f"\nStep 1: Fusing adapter (dequantized)...")
    fused_path.mkdir(parents=True, exist_ok=True)

    fuse_cmd = [
        PYTHON, "-m", "mlx_lm", "fuse",
        "--model", str(BASE_MODEL),
        "--adapter-path", str(adapter_path),
        "--save-path", str(fused_path),
        "--dequantize",
    ]

    try:
        subprocess.run(fuse_cmd, check=True, cwd=str(TRAINER_DIR))
        print(f"  Fused model saved to {fused_path}")
    except subprocess.CalledProcessError as e:
        print(f"  Fuse failed: {e}")
        sys.exit(1)

    if args.skip_ollama:
        print("\nSkipping Ollama deployment (--skip-ollama)")
        return

    # Step 2: Convert to GGUF
    if not args.skip_gguf and CONVERT_SCRIPT.exists() and Path(LLAMA_QUANTIZE).exists():
        print(f"\nStep 2: Converting to GGUF F16...")
        try:
            subprocess.run([
                PYTHON, str(CONVERT_SCRIPT),
                str(fused_path),
                "--outfile", str(gguf_f16),
                "--outtype", "f16",
            ], check=True, cwd=str(TRAINER_DIR))
            print(f"  F16 GGUF: {gguf_f16} ({gguf_f16.stat().st_size / 1e9:.1f}GB)")
        except subprocess.CalledProcessError as e:
            print(f"  GGUF conversion failed: {e}")
            print("  Falling back to safetensors import...")
            _deploy_from_safetensors(version, fused_path)
            return

        # Step 3: Quantize to Q4_K_M
        print(f"\nStep 3: Quantizing to {args.quant}...")
        try:
            subprocess.run([
                LLAMA_QUANTIZE,
                str(gguf_f16),
                str(gguf_quant),
                args.quant,
            ], check=True)
            quant_size = gguf_quant.stat().st_size / 1e9
            print(f"  Quantized GGUF: {gguf_quant} ({quant_size:.1f}GB)")
        except subprocess.CalledProcessError as e:
            print(f"  Quantization failed: {e}")
            print("  Falling back to F16 GGUF...")
            gguf_quant = gguf_f16

        # Step 4: Deploy to Ollama from GGUF
        print(f"\nStep 4: Creating Ollama model from GGUF...")
        _deploy_from_gguf(version, gguf_quant)

        # Clean up large intermediate files
        if gguf_f16.exists() and gguf_quant != gguf_f16:
            print(f"\n  Cleaning up F16 GGUF ({gguf_f16.stat().st_size / 1e9:.1f}GB)...")
            gguf_f16.unlink()

        # Clean up fused safetensors (14GB) — we have the GGUF now
        fused_size = sum(f.stat().st_size for f in fused_path.iterdir() if f.is_file()) / 1e9
        if fused_size > 5:
            print(f"  Cleaning up fused safetensors ({fused_size:.1f}GB)...")
            shutil.rmtree(fused_path)

    else:
        if not CONVERT_SCRIPT.exists():
            print(f"\n  llama.cpp convert script not found at {CONVERT_SCRIPT}")
            print("  Run: git clone --depth 1 https://github.com/ggml-org/llama.cpp.git tools/llama.cpp")
        if not Path(LLAMA_QUANTIZE).exists():
            print(f"  llama-quantize not found at {LLAMA_QUANTIZE}")
            print("  Run: brew install llama.cpp")
        print("  Falling back to safetensors import (15GB model)...")
        _deploy_from_safetensors(version, fused_path)


def _deploy_from_gguf(version, gguf_path):
    """Deploy to Ollama from a GGUF file."""
    model_prefix = DOMAIN.get("model_prefix", "engie-coder")
    system_prompt = DOMAIN.get("deploy_system_prompt", DOMAIN.get("system_prompt", "You are a helpful assistant."))
    ollama_cfg = DOMAIN.get("ollama", {})
    temp = ollama_cfg.get("temperature", 0.7)
    top_p = ollama_cfg.get("top_p", 0.9)
    num_ctx = ollama_cfg.get("num_ctx", 8192)

    modelfile_content = f"""FROM {gguf_path}

SYSTEM "{system_prompt}"

PARAMETER temperature {temp}
PARAMETER top_p {top_p}
PARAMETER num_ctx {num_ctx}
"""
    modelfile_path = GGUF_DIR / f"Modelfile-{version}"
    modelfile_path.write_text(modelfile_content)

    tag = f"{model_prefix}:{version}"
    try:
        subprocess.run(
            ["ollama", "create", tag, "-f", str(modelfile_path)],
            check=True,
        )
        print(f"  Created Ollama model: {tag}")

        subprocess.run(
            ["ollama", "cp", tag, f"{model_prefix}:latest"],
            check=True,
        )
        print(f"  Updated {model_prefix}:latest → {tag}")

        _update_db(version, tag, str(gguf_path))
    except subprocess.CalledProcessError as e:
        print(f"  Ollama create failed: {e}")
        sys.exit(1)


def _deploy_from_safetensors(version, fused_path):
    """Fallback: Deploy directly from safetensors (larger model, ~15GB)."""
    model_prefix = DOMAIN.get("model_prefix", "engie-coder")
    system_prompt = DOMAIN.get("deploy_system_prompt", DOMAIN.get("system_prompt", "You are a helpful assistant."))
    ollama_cfg = DOMAIN.get("ollama", {})
    temp = ollama_cfg.get("temperature", 0.7)
    top_p = ollama_cfg.get("top_p", 0.9)
    num_ctx = ollama_cfg.get("num_ctx", 8192)

    modelfile_content = f"""FROM {fused_path}

SYSTEM "{system_prompt}"

PARAMETER temperature {temp}
PARAMETER top_p {top_p}
PARAMETER num_ctx {num_ctx}
"""
    modelfile_path = FUSED_DIR / f"Modelfile-{version}"
    modelfile_path.write_text(modelfile_content)

    tag = f"{model_prefix}:{version}"
    try:
        subprocess.run(
            ["ollama", "create", tag, "-f", str(modelfile_path)],
            check=True,
        )
        print(f"  Created Ollama model: {tag}")

        subprocess.run(
            ["ollama", "cp", tag, f"{model_prefix}:latest"],
            check=True,
        )
        print(f"  Updated {model_prefix}:latest → {tag}")

        _update_db(version, tag, None)
    except subprocess.CalledProcessError as e:
        print(f"  Ollama create failed: {e}")
        sys.exit(1)


def _update_db(version, ollama_tag, gguf_path):
    """Update forge DB with deployment info."""
    js_parts = [
        f'import {{ updateVersion, setActiveVersion }} from "{TRAINER_DIR}/forge-db.js";',
        f'try {{',
        f'  updateVersion("{version}", {{',
        f'    ollamaTag: "{ollama_tag}",',
        f'    deployed: 1,',
    ]
    if gguf_path:
        js_parts.append(f'    ggufPath: "{gguf_path}",')
    js_parts.extend([
        f'  }});',
        f'  setActiveVersion("{version}");',
        f'}} catch(e) {{ console.error(e.message); }}',
    ])
    js = "\n".join(js_parts)

    try:
        subprocess.run(["bun", "-e", js], capture_output=True, timeout=10)
    except Exception:
        pass

    model_prefix = DOMAIN.get("model_prefix", "engie-coder")
    print(f"\n  Deployment complete! {model_prefix}:{version} is now active.")


if __name__ == "__main__":
    main()
