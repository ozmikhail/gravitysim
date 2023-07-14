#include "lib/cuda/kernel_launchers.h"

#include <cuda_runtime.h>

namespace grav {

namespace {

constexpr int kBlockSize = 256;

__global__ void compute_forces_global_kernel(
    const float* __restrict__ positions,
    const float* __restrict__ masses,
    float* __restrict__ accelerations,
    int n,
    float gravity,
    float softening_sq
) {
    const int i = (blockIdx.x * blockDim.x) + threadIdx.x;
    if (i >= n) {
        return;
    }

    const float xi = positions[(3 * i) + 0];
    const float yi = positions[(3 * i) + 1];
    const float zi = positions[(3 * i) + 2];

    float ax = 0.0F;
    float ay = 0.0F;
    float az = 0.0F;

    for (int j = 0; j < n; ++j) {
        const float dx = positions[(3 * j) + 0] - xi;
        const float dy = positions[(3 * j) + 1] - yi;
        const float dz = positions[(3 * j) + 2] - zi;
        const float r2 = (dx * dx) + (dy * dy) + (dz * dz) + softening_sq;
        const float inv_r3 = rsqrtf(r2 * r2 * r2);
        const float k = gravity * masses[j] * inv_r3;
        ax += dx * k;
        ay += dy * k;
        az += dz * k;
    }

    accelerations[(3 * i) + 0] = ax;
    accelerations[(3 * i) + 1] = ay;
    accelerations[(3 * i) + 2] = az;
}

}

void launch_compute_forces_global(
    const float* d_positions,
    const float* d_masses,
    float* d_accelerations,
    int n,
    float gravity,
    float softening_sq,
    cudaStream_t stream
) {
    const int grid = (n + kBlockSize - 1) / kBlockSize;
    compute_forces_global_kernel<<<grid, kBlockSize, 0, stream>>>(
        d_positions, d_masses, d_accelerations, n, gravity, softening_sq
    );
}

}
