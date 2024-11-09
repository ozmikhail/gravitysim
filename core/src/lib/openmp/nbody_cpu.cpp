#include "lib/openmp/nbody_cpu.h"

#include <cstddef>

#include "lib/openmp/barnes_hut.h"
#include "lib/openmp/gravity_force.h"
#include "lib/openmp/sph.h"
#include "modules/sim/params.h"
#include "modules/sim/particles.h"

namespace grav {

namespace {

template <bool Electrostatic>
void compute_pairwise(Particles& p, float strength, float softening_sq) {
    const std::size_t n = p.count();
    if constexpr (Electrostatic) {
        p.charges.resize(n, 0.0F);
    }
    const auto& sources = Electrostatic ? p.charges : p.masses;

#pragma omp parallel for schedule(static) default(none) shared(p, n, strength, softening_sq, sources)
    for (std::ptrdiff_t i = 0; i < static_cast<std::ptrdiff_t>(n); ++i) {
        Vec3 a{};
        const Vec3 ri = p.positions[i];
        float response = strength;
        if constexpr (Electrostatic) {
            const float mass = p.masses[i];
            response = mass > 0.0F ? -strength * sources[i] / mass : 0.0F;
            if (response == 0.0F) {
                p.accelerations[i] = {};
                continue;
            }
        }
        for (std::size_t j = 0; j < n; ++j) {
            if (j == static_cast<std::size_t>(i)) {
                continue;
            }
            a += softened_acceleration(p.positions[j] - ri, response * sources[j], softening_sq);
        }
        p.accelerations[i] = a;
    }
}

void compute_accelerations(Particles& p, const SimParams& params, float eps2) {
    switch (params.force_model) {
    case ForceModel::Direct:
        compute_pairwise<false>(p, params.gravity, eps2);
        break;
    case ForceModel::BarnesHut:
        compute_barnes_hut(p, params.gravity, eps2, params.barnes_hut_theta);
        break;
    case ForceModel::Sph:
        compute_sph(p, params);
        break;
    case ForceModel::Electrostatic:
        compute_pairwise<true>(p, params.coulomb_strength, eps2);
        break;
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
        compute_accelerations(p, params, eps2);
        for (std::size_t i = 0; i < n; ++i) {
            p.velocities[i] += p.accelerations[i] * dt;
            p.positions[i] += p.velocities[i] * half_dt;
        }
    } else {
        compute_accelerations(p, params, eps2);
        for (std::size_t i = 0; i < n; ++i) {
            p.velocities[i] += p.accelerations[i] * dt;
            p.positions[i] += p.velocities[i] * dt;
        }
    }
    if (params.force_model == ForceModel::Sph) {
        confine_fluid(p);
    }
}

}
