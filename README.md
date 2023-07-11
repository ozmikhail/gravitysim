# gravitysim

> A real-time CUDA-accelerated N-body gravitational simulator with OpenGL visualization plus an OpenMP CPU fallback.

[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

A from-scratch all-pairs N-body simulator. Particles attract each other under Newtonian gravity.

## Features

- O(N²) gravitational simulation (Euler, symplectic Leapfrog)
- OpenMP-parallel CPU backend
- Dear ImGui controls
- Built-in scenarios: random cluster, solar system, colliding galaxies

## Quick start

```bash
make build
./build/simulator core/config.toml
```

## License

MIT — see [LICENSE](LICENSE).
