#include "lib/openmp/nbody_cpu.h"

#include <cmath>
#include <cstddef>

#include "modules/sim/params.h"
#include "modules/sim/particles.h"

namespace grav {

namespace {

void compute_accelerations(Particles& p, float gravity, float softening_sq) {
    const std::size_t n = p.count();

#pragma omp parallel for schedule(static) default(none)                            \
    shared(p, n, gravity, softening_sq)
    for (std::ptrdiff_t i = 0; i < static_cast<std::ptrdiff_t>(n); ++i) {
        Vec3 a{};
        const Vec3 ri = p.positions[i];
        for (std::size_t j = 0; j < n; ++j) {
            if (j == static_cast<std::size_t>(i)) {
                continue;
            }
            const Vec3 d = p.positions[j] - ri;
            const float r2 = (d.x * d.x) + (d.y * d.y) + (d.z * d.z) + softening_sq;
            const float inv_r3 = 1.0F / (r2 * std::sqrt(r2));
            const float k = gravity * p.masses[j] * inv_r3;
            a += d * k;
        }
        p.accelerations[i] = a;
    }
}

}

void cpu_step(Particles& p, const SimParams& params) {
    const std::size_t n = p.count();
    if (n == 0) {
        return;
    }
    if (p.accelerations.size() != n) {
        p.accelerations.assign(n, Vec3{});
    }

    const float dt = params.dt;
    const float eps2 = params.softening * params.softening;

    if (params.integrator == Integrator::Leapfrog) {
        const float half_dt = 0.5F * dt;
        for (std::size_t i = 0; i < n; ++i) {
            p.positions[i] += p.velocities[i] * half_dt;
        }
        compute_accelerations(p, params.gravity, eps2);
        for (std::size_t i = 0; i < n; ++i) {
            p.velocities[i] += p.accelerations[i] * dt;
            p.positions[i] += p.velocities[i] * half_dt;
        }
        return;
    }

    compute_accelerations(p, params.gravity, eps2);
    for (std::size_t i = 0; i < n; ++i) {
        p.velocities[i] += p.accelerations[i] * dt;
        p.positions[i] += p.velocities[i] * dt;
    }
}

}
