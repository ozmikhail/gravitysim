#include "lib/cuda/kernel_launchers.h"

#include <cuda_runtime.h>

namespace grav {

namespace {

constexpr int kBlockSize = 256;

__global__ void drift_kernel(
    float* positions,
    const float* velocities,
    int n,
    float dt
) {
    const int i = (blockIdx.x * blockDim.x) + threadIdx.x;
    if (i >= n) {
        return;
    }
    const int o = 3 * i;
    positions[o + 0] += velocities[o + 0] * dt;
    positions[o + 1] += velocities[o + 1] * dt;
    positions[o + 2] += velocities[o + 2] * dt;
}

__global__ void kick_kernel(
    float* velocities,
    const float* accelerations,
    int n,
    float dt
) {
    const int i = (blockIdx.x * blockDim.x) + threadIdx.x;
    if (i >= n) {
        return;
    }
    const int o = 3 * i;
    velocities[o + 0] += accelerations[o + 0] * dt;
    velocities[o + 1] += accelerations[o + 1] * dt;
    velocities[o + 2] += accelerations[o + 2] * dt;
}

__global__ void integrate_euler_kernel(
    float* positions,
    float* velocities,
    const float* accelerations,
    int n,
    float dt
) {
    const int i = (blockIdx.x * blockDim.x) + threadIdx.x;
    if (i >= n) {
        return;
    }
    const int o = 3 * i;
    velocities[o + 0] += accelerations[o + 0] * dt;
    velocities[o + 1] += accelerations[o + 1] * dt;
    velocities[o + 2] += accelerations[o + 2] * dt;
    positions[o + 0] += velocities[o + 0] * dt;
    positions[o + 1] += velocities[o + 1] * dt;
    positions[o + 2] += velocities[o + 2] * dt;
}

}

void launch_integrate_euler(
    float* d_positions,
    float* d_velocities,
    const float* d_accelerations,
    int n,
    float dt,
    cudaStream_t stream
) {
    const int grid = (n + kBlockSize - 1) / kBlockSize;
    integrate_euler_kernel<<<grid, kBlockSize, 0, stream>>>(
        d_positions, d_velocities, d_accelerations, n, dt
    );
}

void launch_drift(
    float* d_positions,
    const float* d_velocities,
    int n,
    float dt,
    cudaStream_t stream
) {
    const int grid = (n + kBlockSize - 1) / kBlockSize;
    drift_kernel<<<grid, kBlockSize, 0, stream>>>(d_positions, d_velocities, n, dt);
}

void launch_kick(
    float* d_velocities,
    const float* d_accelerations,
    int n,
    float dt,
    cudaStream_t stream
) {
    const int grid = (n + kBlockSize - 1) / kBlockSize;
    kick_kernel<<<grid, kBlockSize, 0, stream>>>(d_velocities, d_accelerations, n, dt);
}

}
