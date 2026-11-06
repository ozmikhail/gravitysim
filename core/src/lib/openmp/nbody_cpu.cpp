#include "lib/openmp/nbody_cpu.h"

#include "lib/openmp/barnes_hut.h"
#include "lib/openmp/gravity_force.h"
#include "lib/openmp/sph.h"
#include "modules/sim/integrator.h"
#include "modules/sim/params.h"
#include "modules/sim/particles.h"

#include <cstddef>

namespace grav {

namespace {

float electrostatic_response(float strength, float charge, float mass) {
  return mass > 0.0F ? -strength * charge / mass : 0.0F;
}

template <bool Electrostatic>
void compute_pairwise(float strength, Particles& particles, float softening_sq) {
  const std::size_t count = count_particles(particles);
  if constexpr (Electrostatic) {
    particles.charges.resize(count, 0.0F);
  }
  const auto& sources = Electrostatic ? particles.charges : particles.masses;

#pragma omp parallel for schedule(static) default(none)                                            \
    shared(particles, count, strength, softening_sq, sources)
  for (std::size_t i = 0; i < count; ++i) {
    Vec3 acc{};
    const Vec3 pos_i = particles.positions.at(i);
    const float response =
        Electrostatic ? electrostatic_response(strength, sources.at(i), particles.masses.at(i))
                      : strength;
    if constexpr (Electrostatic) {
      if (response == 0.0F) {
        particles.accelerations.at(i) = {};
        continue;
      }
    }
    for (std::size_t j = 0; j < count; ++j) {
      if (j == i) {
        continue;
      }
      acc += softened_acceleration(response * sources.at(j), particles.positions.at(j) - pos_i,
                                   softening_sq);
    }
    particles.accelerations.at(i) = acc;
  }
}

void compute_accelerations(Particles& particles, const SimParams& params, float eps2) {
  switch (params.force_model) {
  case ForceModel::Direct:
    compute_pairwise<false>(params.gravity, particles, eps2);
    break;
  case ForceModel::BarnesHut:
    compute_barnes_hut(particles, params, eps2);
    break;
  case ForceModel::Sph:
    compute_sph(particles, params);
    break;
  case ForceModel::Electrostatic:
    compute_pairwise<true>(params.coulomb_strength, particles, eps2);
    break;
  }
}

} // namespace

void cpu_step(Particles& particles, const SimParams& params) {
  const std::size_t count = count_particles(particles);
  if (count == 0) {
    return;
  }
  if (particles.accelerations.size() != count) {
    particles.accelerations.assign(count, Vec3{});
  }

  const float time_step = params.dt;
  const float eps2 = params.softening * params.softening;

  if (params.integrator == Integrator::Leapfrog) {
    const float half_dt = 0.5F * time_step;
    for (std::size_t i = 0; i < count; ++i) {
      particles.positions.at(i) += particles.velocities.at(i) * half_dt;
    }
    compute_accelerations(particles, params, eps2);
    for (std::size_t i = 0; i < count; ++i) {
      particles.velocities.at(i) += particles.accelerations.at(i) * time_step;
      particles.positions.at(i) += particles.velocities.at(i) * half_dt;
    }
  } else {
    compute_accelerations(particles, params, eps2);
    for (std::size_t i = 0; i < count; ++i) {
      particles.velocities.at(i) += particles.accelerations.at(i) * time_step;
      particles.positions.at(i) += particles.velocities.at(i) * time_step;
    }
  }
  if (params.force_model == ForceModel::Sph) {
    confine_fluid(particles);
  }
}

} // namespace grav
