#pragma once

#include <cuda_runtime.h>

namespace grav {

void launch_compute_forces_global(
    const float* d_positions,
    const float* d_masses,
    float* d_accelerations,
    int n,
    float gravity,
    float softening_sq,
    cudaStream_t stream
);

void launch_compute_forces_tiled(
    const float* d_positions,
    const float* d_masses,
    float* d_accelerations,
    int n,
    float gravity,
    float softening_sq,
    cudaStream_t stream
);

void launch_pack_pos_mass(
    float4* d_pos_mass,
    const float* d_positions,
    const float* d_masses,
    int n,
    cudaStream_t stream
);

void launch_compute_forces_float4(
    const float4* d_pos_mass,
    float* d_accelerations,
    int n,
    float gravity,
    float softening_sq,
    cudaStream_t stream
);

void launch_integrate_euler(
    float* d_positions,
    float* d_velocities,
    const float* d_accelerations,
    int n,
    float dt,
    cudaStream_t stream
);

void launch_drift(
    float* d_positions,
    const float* d_velocities,
    int n,
    float dt,
    cudaStream_t stream
);

void launch_kick(
    float* d_velocities,
    const float* d_accelerations,
    int n,
    float dt,
    cudaStream_t stream
);

}
