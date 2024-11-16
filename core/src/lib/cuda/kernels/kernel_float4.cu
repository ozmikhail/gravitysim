#include "lib/cuda/kernel_launchers.h"

#include <cuda_runtime.h>

namespace grav {

namespace {

constexpr int kBlockSize = 256;

__global__ void pack_pos_mass_kernel(
    float4* __restrict__ pos_mass,
    const float* __restrict__ positions,
    const float* __restrict__ masses,
    int n
) {
    const int i = (blockIdx.x * blockDim.x) + threadIdx.x;
    if (i >= n) {
        return;
    }
    pos_mass[i] = make_float4(
        positions[(3 * i) + 0],
        positions[(3 * i) + 1],
        positions[(3 * i) + 2],
        masses[i]
    );
}

__global__ void compute_forces_float4_kernel(
    const float4* __restrict__ pos_mass,
    float* __restrict__ accelerations,
    int n,
    float gravity,
    float softening_sq
) {
    __shared__ float4 sh_posm[kBlockSize];

    const int i = (blockIdx.x * kBlockSize) + threadIdx.x;
    const float4 pi = (i < n) ? pos_mass[i] : make_float4(0.0F, 0.0F, 0.0F, 0.0F);

    float ax = 0.0F;
    float ay = 0.0F;
    float az = 0.0F;

    const int num_tiles = (n + kBlockSize - 1) / kBlockSize;
    for (int tile = 0; tile < num_tiles; ++tile) {
        const int j = (tile * kBlockSize) + threadIdx.x;
        sh_posm[threadIdx.x] =
            (j < n) ? pos_mass[j] : make_float4(0.0F, 0.0F, 0.0F, 0.0F);
        __syncthreads();

        if (i < n) {
            const int tile_end = min(kBlockSize, n - (tile * kBlockSize));
#pragma unroll 8
            for (int k = 0; k < tile_end; ++k) {
                const float4 pj = sh_posm[k];
                const float dx = pj.x - pi.x;
                const float dy = pj.y - pi.y;
                const float dz = pj.z - pi.z;
                const float r2 =
                    fmaf(dx, dx, fmaf(dy, dy, fmaf(dz, dz, softening_sq)));
                if (r2 == 0.0F) {
                    continue;
                }
                const float inv_r3 = rsqrtf(r2 * r2 * r2);
                const float kv = gravity * pj.w * inv_r3;
                ax = fmaf(dx, kv, ax);
                ay = fmaf(dy, kv, ay);
                az = fmaf(dz, kv, az);
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

void launch_pack_pos_mass(
    float4* d_pos_mass,
    const float* d_positions,
    const float* d_masses,
    int n,
    cudaStream_t stream
) {
    const int grid = (n + kBlockSize - 1) / kBlockSize;
    pack_pos_mass_kernel<<<grid, kBlockSize, 0, stream>>>(
        d_pos_mass, d_positions, d_masses, n
    );
}

void launch_compute_forces_float4(
    const float4* d_pos_mass,
    float* d_accelerations,
    int n,
    float gravity,
    float softening_sq,
    cudaStream_t stream
) {
    const int grid = (n + kBlockSize - 1) / kBlockSize;
    compute_forces_float4_kernel<<<grid, kBlockSize, 0, stream>>>(
        d_pos_mass, d_accelerations, n, gravity, softening_sq
    );
}

}
