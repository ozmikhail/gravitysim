#include <cuda_runtime.h>

#include <cstddef>
#include <format>
#include <memory>
#include <string>

#include "error.h"
#include "lib/cuda/cuda_interop.h"
#include "lib/cuda/kernel_launchers.h"
#include "modules/sim/particles.h"
#include "modules/sim/simulation.h"

namespace grav {

namespace {

#define GRAV_CUDA_CHECK(expr)                                               \
    do {                                                                    \
        cudaError_t _e = (expr);                                            \
        if (_e != cudaSuccess) {                                            \
            throw AppError::dependency_unavailable(                         \
                std::format("cuda: {}: {}", #expr, cudaGetErrorString(_e))  \
            );                                                              \
        }                                                                   \
    } while (0)

struct CudaSimState {
    std::unique_ptr<cuda::GlBufferInterop> position_interop;
    float* d_positions = nullptr;
    float* d_velocities = nullptr;
    float* d_masses = nullptr;
    float* d_accelerations = nullptr;
    float4* d_pos_mass = nullptr;
    std::size_t capacity = 0;
    std::uint32_t bound_vbo = 0;
    cudaStream_t stream = nullptr;

    ~CudaSimState() {
        if (d_positions != nullptr) cudaFree(d_positions);
        if (d_velocities != nullptr) cudaFree(d_velocities);
        if (d_masses != nullptr) cudaFree(d_masses);
        if (d_accelerations != nullptr) cudaFree(d_accelerations);
        if (d_pos_mass != nullptr) cudaFree(d_pos_mass);
        if (stream != nullptr) cudaStreamDestroy(stream);
    }
};

void delete_cuda_state(void* p) {
    delete static_cast<CudaSimState*>(p);
}

CudaSimState* state_of(Simulation& sim) {
    return static_cast<CudaSimState*>(sim.backend_state.get());
}

void ensure_capacity(Simulation& sim, std::size_t n) {
    const std::size_t pos_bytes = n * 3 * sizeof(float);
    const std::size_t pos_mass_bytes = n * sizeof(float4);

    auto* existing = state_of(sim);
    const bool capacity_ok = existing != nullptr && existing->capacity >= n;
    const bool interop_match = existing != nullptr && existing->bound_vbo == sim.output_vbo;
    const bool needs_pos_mass = sim.params.kernel_variant == KernelVariant::Float4;
    const bool pos_mass_ok =
        existing != nullptr && (!needs_pos_mass || existing->d_pos_mass != nullptr);

    if (capacity_ok && interop_match && pos_mass_ok) {
        return;
    }

    auto state = std::make_unique<CudaSimState>();
    state->capacity = n;
    state->bound_vbo = sim.output_vbo;
    GRAV_CUDA_CHECK(cudaStreamCreate(&state->stream));

    if (sim.output_vbo != 0) {
        state->position_interop =
            std::make_unique<cuda::GlBufferInterop>(sim.output_vbo, pos_bytes);
    } else {
        GRAV_CUDA_CHECK(cudaMalloc(&state->d_positions, pos_bytes));
    }
    GRAV_CUDA_CHECK(cudaMalloc(&state->d_velocities, pos_bytes));
    GRAV_CUDA_CHECK(cudaMalloc(&state->d_masses, n * sizeof(float)));
    GRAV_CUDA_CHECK(cudaMalloc(&state->d_accelerations, pos_bytes));
    if (needs_pos_mass) {
        GRAV_CUDA_CHECK(cudaMalloc(&state->d_pos_mass, pos_mass_bytes));
    }

    sim.backend_state = std::unique_ptr<void, void (*)(void*)>(
        state.release(), &delete_cuda_state
    );
}

void launch_force_kernel(
    const SimParams& params,
    float* d_pos,
    float* d_masses,
    float* d_accelerations,
    float4* d_pos_mass,
    int n,
    float eps2,
    cudaStream_t stream
) {
    switch (params.kernel_variant) {
    case KernelVariant::Global:
        launch_compute_forces_global(
            d_pos, d_masses, d_accelerations, n, params.gravity, eps2, stream
        );
        return;
    case KernelVariant::Tiled:
        launch_compute_forces_tiled(
            d_pos, d_masses, d_accelerations, n, params.gravity, eps2, stream
        );
        return;
    case KernelVariant::Float4:
        launch_pack_pos_mass(d_pos_mass, d_pos, d_masses, n, stream);
        launch_compute_forces_float4(
            d_pos_mass, d_accelerations, n, params.gravity, eps2, stream
        );
        return;
    }
}

}

void cuda_step(Simulation& sim) {
    const std::size_t n = sim.particles.count();
    if (n == 0) {
        return;
    }

    ensure_capacity(sim, n);
    auto* s = state_of(sim);

    const std::size_t pos_bytes = n * 3 * sizeof(float);
    const std::size_t mass_bytes = n * sizeof(float);

    float* d_pos = s->d_positions;
    if (s->position_interop != nullptr) {
        d_pos = static_cast<float*>(s->position_interop->map(s->stream));
    } else {
        GRAV_CUDA_CHECK(cudaMemcpyAsync(
            d_pos, sim.particles.positions.data(), pos_bytes,
            cudaMemcpyHostToDevice, s->stream
        ));
    }

    GRAV_CUDA_CHECK(cudaMemcpyAsync(
        s->d_velocities, sim.particles.velocities.data(), pos_bytes,
        cudaMemcpyHostToDevice, s->stream
    ));
    GRAV_CUDA_CHECK(cudaMemcpyAsync(
        s->d_masses, sim.particles.masses.data(), mass_bytes,
        cudaMemcpyHostToDevice, s->stream
    ));

    const float eps2 = sim.params.softening * sim.params.softening;
    const int ni = static_cast<int>(n);
    const float dt = sim.params.dt;

    if (sim.params.integrator == Integrator::Leapfrog) {
        launch_drift(d_pos, s->d_velocities, ni, 0.5F * dt, s->stream);
        launch_force_kernel(
            sim.params, d_pos, s->d_masses, s->d_accelerations, s->d_pos_mass,
            ni, eps2, s->stream
        );
        launch_kick(s->d_velocities, s->d_accelerations, ni, dt, s->stream);
        launch_drift(d_pos, s->d_velocities, ni, 0.5F * dt, s->stream);
    } else {
        launch_force_kernel(
            sim.params, d_pos, s->d_masses, s->d_accelerations, s->d_pos_mass,
            ni, eps2, s->stream
        );
        launch_integrate_euler(d_pos, s->d_velocities, s->d_accelerations, ni, dt, s->stream);
    }

    if (s->position_interop != nullptr) {
        s->position_interop->unmap(s->stream);
    } else {
        GRAV_CUDA_CHECK(cudaMemcpyAsync(
            sim.particles.positions.data(), d_pos, pos_bytes,
            cudaMemcpyDeviceToHost, s->stream
        ));
    }
    GRAV_CUDA_CHECK(cudaMemcpyAsync(
        sim.particles.velocities.data(), s->d_velocities, pos_bytes,
        cudaMemcpyDeviceToHost, s->stream
    ));

    GRAV_CUDA_CHECK(cudaStreamSynchronize(s->stream));
    GRAV_CUDA_CHECK(cudaPeekAtLastError());
}

}
