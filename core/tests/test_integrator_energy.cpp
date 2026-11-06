#include "modules/sim/integrator.h"
#include "modules/sim/params.h"
#include "modules/sim/particles.h"
#include "modules/sim/simulation.h"

#include <catch2/catch_message.hpp>
#include <catch2/catch_test_macros.hpp>
#include <cmath>
#include <cstddef>

namespace {

constexpr float HALF = 0.5F;
constexpr float SOFTENING = 0.001F;
constexpr float SEPARATION = 0.4F;
constexpr float SATELLITE_MASS = 0.001F;

float total_energy(const grav::Simulation& sim) {
  const auto& particles = sim.particles;
  float kinetic = 0.0F;
  for (std::size_t i = 0; i < count_particles(particles); ++i) {
    kinetic += HALF * particles.masses.at(i) * grav::length_squared(particles.velocities.at(i));
  }

  const float eps2 = sim.params.softening * sim.params.softening;
  float potential = 0.0F;
  for (std::size_t i = 0; i < count_particles(particles); ++i) {
    for (std::size_t j = i + 1; j < count_particles(particles); ++j) {
      const grav::Vec3 separation = particles.positions.at(j) - particles.positions.at(i);
      const float distance = std::sqrt(grav::length_squared(separation) + eps2);
      potential -= sim.params.gravity * particles.masses.at(i) * particles.masses.at(j) / distance;
    }
  }
  return kinetic + potential;
}

float run_two_body(grav::Integrator integrator, float timestep) {
  constexpr int steps = 4000;

  grav::Simulation sim;
  sim.backend = grav::Backend::Cpu;
  sim.params.dt = timestep;
  sim.params.gravity = 1.0F;
  sim.params.softening = SOFTENING;
  sim.params.integrator = integrator;

  resize_particles(sim.particles, 2);
  sim.particles.positions.at(0) = {.x = 0.0F, .y = 0.0F, .z = 0.0F};
  sim.particles.positions.at(1) = {.x = SEPARATION, .y = 0.0F, .z = 0.0F};
  sim.particles.velocities.at(0) = {.x = 0.0F, .y = 0.0F, .z = 0.0F};
  sim.particles.velocities.at(1) = {.x = 0.0F, .y = std::sqrt(1.0F / SEPARATION), .z = 0.0F};
  sim.particles.masses.at(0) = 1.0F;
  sim.particles.masses.at(1) = SATELLITE_MASS;

  const float energy_before = total_energy(sim);
  for (int i = 0; i < steps; ++i) {
    grav::step(sim);
  }
  const float energy_after = total_energy(sim);
  return std::abs(energy_after - energy_before) / std::abs(energy_before);
}

} // namespace

TEST_CASE("leapfrog drifts less than euler on a 2-body orbit", "[integrator]") {
  constexpr float timestep = 0.005F;

  const float drift_euler = run_two_body(grav::Integrator::Euler, timestep);
  const float drift_leapfrog = run_two_body(grav::Integrator::Leapfrog, timestep);

  INFO("euler drift = " << drift_euler);
  INFO("leapfrog drift = " << drift_leapfrog);

  REQUIRE(drift_leapfrog < drift_euler);
}
