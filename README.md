# gravitysim

> A real-time CUDA-accelerated N-body gravitational simulator with OpenGL visualization, three optimization tiers, and an OpenMP CPU fallback for laptop development.

[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![C++20](https://img.shields.io/badge/C%2B%2B-20-blue.svg)](CMakeLists.txt)

A from-scratch all-pairs N-body simulator for studying CUDA optimization techniques. Particles attract each other under Newtonian gravity. The simulator ships three CUDA kernel variants (global memory, shared-memory tiling, packed `float4`) so you can profile each step of the optimization progression on the same scene. CUDA-OpenGL interop renders particles directly from the GPU buffer with no host round-trip. An OpenMP CPU path keeps the project usable on machines without an NVIDIA GPU (including macOS for development).

![preview](preview.gif)

## Features

- O(N²) gravitational simulation with Euler and symplectic Leapfrog integrators
- Three CUDA force kernels selectable at runtime: `global`, `tiled`, `float4`
- Zero-copy CUDA-OpenGL interop — kernels write to the rendered VBO directly
- OpenMP-parallel CPU backend for development without CUDA hardware
- Dear ImGui controls: pause / step / reset, dt / G / softening sliders, integrator / kernel / scenario pickers
- Built-in scenarios: random cluster, solar system, colliding galaxies
- Speed-coloured point sprites with alpha blending
- Live FPS and particle-pairs/sec overlay
- Catch2 unit tests covering integrators, scenarios, and metrics — no GL/CUDA dependency

## Quick start

### Linux + NVIDIA (full path with CUDA)

```bash
git clone https://github.com/<user>/gravitysim.git
cd gravitysim
make build              # configure and compile, BUILD_CUDA defaults ON on Linux
./build/simulator core/config.toml
```

### macOS (CPU + OpenMP only)

CUDA does not run on modern macOS. The build automatically disables CUDA on Apple and uses the OpenMP CPU backend. `libomp` is required:

```bash
brew install libomp
git clone https://github.com/<user>/gravitysim.git
cd gravitysim
make build
./build/simulator core/config.toml
```

## Development

```bash
make check              # format + lint + typecheck + test
make test               # Catch2 unit tests (no GL/CUDA needed)
make build              # release build
make clean              # wipe build/
```

The test executable links only `sim_lib + scenarios_lib + metrics_lib + openmp_adapter` — never GL, GLFW, ImGui, or CUDA. This is enforced by the build, ensuring the lib/modules separation holds.

## Configuration

Startup-time knobs live in `core/config.toml` (window size, default particle count, integrator, kernel variant, max history). Runtime knobs (dt, G, paused, scenario selection) live in the ImGui panel.

`max_particles` is fixed at startup because the GL VBO is registered with CUDA once and cannot grow.

## Optimization progression

The three CUDA force kernels are separate `.cu` files under `core/src/lib/cuda/kernels/`. Switch between them at runtime via the `cuda kernel` dropdown to see the effect on `particle-pairs/sec` in the metrics overlay.

| Variant | File | Technique |
|---|---|---|
| `global` | `kernel_global.cu` | Naive O(N²); scalar global-memory loads |
| `tiled` | `kernel_tiled.cu` | Shared-memory tile of 256 bodies; `#pragma unroll 8` |
| `float4` | `kernel_float4.cu` | Packed `float4` (pos + mass) reads, `__restrict__`, FMA |

Speedup numbers from your hardware go in `docs/kernels.md` (run `nsys profile ./build/simulator` to populate).

## Deferred (future work)

- Per-particle trails (ring-buffer history VBO drawn as line strips)
- Merge-on-collision kernel
- Barnes-Hut O(N log N) tree-based force approximation
- Frame / position-stream export
- SPH fluid and electrostatic-charge variants

## License

MIT — see [LICENSE](LICENSE).
