#include "lib/cuda/kernel_launchers.h"

#include <cuda_runtime.h>

namespace grav {

namespace {

constexpr int kBlockSize = 256;

__global__ void compute_forces_tiled_kernel(
    const float* __restrict__ positions,
    const float* __restrict__ masses,
    float* __restrict__ accelerations,
    int n,
    float gravity,
    float softening_sq
) {
    __shared__ float sh_pos_x[kBlockSize];
    __shared__ float sh_pos_y[kBlockSize];
    __shared__ float sh_pos_z[kBlockSize];
    __shared__ float sh_mass[kBlockSize];

    const int i = (blockIdx.x * kBlockSize) + threadIdx.x;

    float xi = 0.0F;
    float yi = 0.0F;
    float zi = 0.0F;
    if (i < n) {
        xi = positions[(3 * i) + 0];
        yi = positions[(3 * i) + 1];
        zi = positions[(3 * i) + 2];
    }

    float ax = 0.0F;
    float ay = 0.0F;
    float az = 0.0F;

    const int num_tiles = (n + kBlockSize - 1) / kBlockSize;
    for (int tile = 0; tile < num_tiles; ++tile) {
        const int j = (tile * kBlockSize) + threadIdx.x;
        if (j < n) {
            sh_pos_x[threadIdx.x] = positions[(3 * j) + 0];
            sh_pos_y[threadIdx.x] = positions[(3 * j) + 1];
            sh_pos_z[threadIdx.x] = positions[(3 * j) + 2];
            sh_mass[threadIdx.x] = masses[j];
        } else {
            sh_pos_x[threadIdx.x] = 0.0F;
            sh_pos_y[threadIdx.x] = 0.0F;
            sh_pos_z[threadIdx.x] = 0.0F;
            sh_mass[threadIdx.x] = 0.0F;
        }
        __syncthreads();

        if (i < n) {
            const int tile_end = min(kBlockSize, n - (tile * kBlockSize));
#pragma unroll 8
            for (int k = 0; k < tile_end; ++k) {
                const float dx = sh_pos_x[k] - xi;
                const float dy = sh_pos_y[k] - yi;
                const float dz = sh_pos_z[k] - zi;
                const float r2 = (dx * dx) + (dy * dy) + (dz * dz) + softening_sq;
                const float inv_r3 = rsqrtf(r2 * r2 * r2);
                const float kv = gravity * sh_mass[k] * inv_r3;
                ax += dx * kv;
                ay += dy * kv;
                az += dz * kv;
            }
        }
        __syncthreads();
    }

    if (i < n) {
        accelerations[(3 * i) + 0] = ax;
        accelerations[(3 * i) + 1] = ay;
        accelerations[(3 * i) + 2] = az;
    }
}

}

void launch_compute_forces_tiled(
    const float* d_positions,
    const float* d_masses,
    float* d_accelerations,
    int n,
    float gravity,
    float softening_sq,
    cudaStream_t stream
) {
    const int grid = (n + kBlockSize - 1) / kBlockSize;
    compute_forces_tiled_kernel<<<grid, kBlockSize, 0, stream>>>(
        d_positions, d_masses, d_accelerations, n, gravity, softening_sq
    );
}

}
