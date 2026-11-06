#include "error.h"
#include "modules/scenarios/scenarios.h"
#include "modules/sim/integrator.h"
#include "modules/sim/params.h"
#include "modules/sim/particles.h"
#include "modules/sim/simulation.h"

#include <catch2/catch_test_macros.hpp>
#include <cmath>
#include <cstddef>
#include <cstdint>

TEST_CASE("cpu step does not produce NaN positions", "[sim]") {
  constexpr float timestep = 0.001F;
  constexpr float softening = 0.05F;
  constexpr std::size_t body_count = 64;
  constexpr std::uint64_t seed = 42;
  constexpr int step_count = 100;

  grav::Simulation sim;
  sim.backend = grav::Backend::Cpu;
  sim.params.dt = timestep;
  sim.params.gravity = 1.0F;
  sim.params.softening = softening;
  sim.params.integrator = grav::Integrator::Leapfrog;

  grav::scenarios::random_cluster(sim.particles, body_count, grav::scenarios::Seed{seed});

  for (int i = 0; i < step_count; ++i) {
    grav::step(sim);
  }

  for (const auto& position : sim.particles.positions) {
    REQUIRE(std::isfinite(position.x));
    REQUIRE(std::isfinite(position.y));
    REQUIRE(std::isfinite(position.z));
  }
}

TEST_CASE("reset to unknown scenario throws not_found", "[sim]") {
  grav::Simulation sim;
  REQUIRE_THROWS_AS(grav::reset(sim, "no_such_scenario", 64), AppError);
}

TEST_CASE("reset to random_cluster sizes particle arrays", "[sim]") {
  constexpr std::size_t body_count = 256;

  grav::Simulation sim;
  grav::reset(sim, "random_cluster", body_count);
  REQUIRE(count_particles(sim.particles) == 256);
  REQUIRE(sim.particles.positions.size() == 256);
  REQUIRE(sim.particles.velocities.size() == 256);
  REQUIRE(sim.particles.masses.size() == 256);
}

TEST_CASE("collisions merge connected bodies and preserve survivor IDs", "[sim][collision]") {
  constexpr float merge_radius = 0.1F;
  constexpr float second_x = 0.08F;
  constexpr float third_x = 0.16F;
  constexpr float first_speed = 2.0F;
  constexpr float first_mass = 2.0F;
  constexpr float second_mass = 3.0F;
  constexpr float fourth_mass = 7.0F;
  constexpr float merged_mass = 6.0F;
  constexpr float merged_x = 0.4F;
  constexpr float tolerance = 1e-6F;

  grav::Simulation sim;
  sim.params.gravity = 0.0F;
  sim.params.dt = 0.0F;
  sim.params.merge_on_collision = true;
  sim.params.merge_radius = merge_radius;
  auto& particles = sim.particles;
  resize_particles(particles, 4);
  particles.positions = {
      {.x = 0.0F, .y = 0.0F, .z = 0.0F},
      {.x = second_x, .y = 0.0F, .z = 0.0F},
      {.x = third_x, .y = 0.0F, .z = 0.0F},
      {.x = 1.0F, .y = 0.0F, .z = 0.0F},
  };
  particles.velocities = {
      {.x = first_speed, .y = 0.0F, .z = 0.0F},
      {.x = -1.0F, .y = 0.0F, .z = 0.0F},
      {.x = 0.0F, .y = 0.0F, .z = 0.0F},
      {.x = 0.0F, .y = 0.0F, .z = 0.0F},
  };
  particles.masses = {first_mass, second_mass, 1.0F, fourth_mass};

  grav::step(sim);

  REQUIRE(count_particles(particles) == 2);
  REQUIRE(id_of(particles, 0) == 0);
  REQUIRE(id_of(particles, 1) == 3);
  REQUIRE(particles.masses.at(0) == merged_mass);
  REQUIRE(particles.masses.at(1) == fourth_mass);
  REQUIRE(std::abs(particles.positions.at(0).x - (merged_x / merged_mass)) < tolerance);
  REQUIRE(std::abs((particles.velocities.at(0).x * particles.masses.at(0)) - 1.0F) < tolerance);
  REQUIRE(particles.velocities.size() == count_particles(particles));
  REQUIRE(particles.accelerations.size() == count_particles(particles));
  grav::step(sim);
  REQUIRE(id_of(particles, 1) == 3);
}

TEST_CASE("Barnes-Hut agrees with direct gravity at tight opening angles", "[sim][barnes_hut]") {
  constexpr std::size_t body_count = 512;
  constexpr std::uint64_t seed = 35;
  constexpr double exact_tolerance = 1e-5;
  constexpr double tree_tolerance = 0.03;

  grav::Simulation exact;
  grav::scenarios::random_cluster(exact.particles, body_count, grav::scenarios::Seed{seed});
  exact.params.dt = 0.0F;
  grav::step(exact);

  grav::Simulation tree;
  tree.backend = grav::Backend::Cuda;
  tree.particles = exact.particles;
  tree.params = exact.params;
  tree.params.force_model = grav::ForceModel::BarnesHut;
  REQUIRE(grav::active_backend(tree) == grav::Backend::Cpu);

  for (const float theta : {0.0F, 0.6F}) {
    tree.params.barnes_hut_theta = theta;
    grav::step(tree);
    double error_sq = 0.0;
    double exact_sq = 0.0;
    for (std::size_t i = 0; i < count_particles(tree.particles); ++i) {
      const auto acceleration = exact.particles.accelerations.at(i);
      error_sq += grav::length_squared(tree.particles.accelerations.at(i) - acceleration);
      exact_sq += grav::length_squared(acceleration);
    }
    REQUIRE(std::sqrt(error_sq / exact_sq) < (theta == 0.0F ? exact_tolerance : tree_tolerance));
  }
}

TEST_CASE("Barnes-Hut handles coincident bodies without self-force", "[sim][barnes_hut]") {
  constexpr std::size_t body_count = 100;

  grav::Simulation sim;
  sim.params.force_model = grav::ForceModel::BarnesHut;
  sim.params.softening = 0.0F;
  resize_particles(sim.particles, body_count);
  grav::step(sim);
  for (const auto acceleration : sim.particles.accelerations) {
    REQUIRE(grav::length_squared(acceleration) == 0.0F);
  }
}

TEST_CASE("SPH pressure and viscosity act only within the smoothing radius", "[sim][sph]") {
  constexpr float near_offset = 0.03F;
  constexpr float far_offset = 0.6F;
  constexpr float mass = 0.02F;

  grav::Simulation sim;
  sim.backend = grav::Backend::Cuda;
  sim.params.force_model = grav::ForceModel::Sph;
  sim.params.gravity = 0.0F;
  sim.params.dt = 0.0F;
  auto& particles = sim.particles;
  resize_particles(particles, 3);
  particles.positions = {
      {.x = -near_offset, .y = 0.0F, .z = 0.0F},
      {.x = near_offset, .y = 0.0F, .z = 0.0F},
      {.x = far_offset, .y = 0.0F, .z = 0.0F},
  };
  particles.masses = {mass, mass, mass};

  grav::step(sim);
  REQUIRE(particles.accelerations.at(0).x < 0.0F);
  REQUIRE(particles.accelerations.at(1).x == -particles.accelerations.at(0).x);
  REQUIRE(grav::length_squared(particles.accelerations.at(2)) == 0.0F);

  sim.params.sph_stiffness = 0.0F;
  particles.velocities = {
      {.x = 1.0F, .y = 0.0F, .z = 0.0F},
      {.x = -1.0F, .y = 0.0F, .z = 0.0F},
      {.x = 0.0F, .y = 0.0F, .z = 0.0F},
  };
  grav::step(sim);
  REQUIRE(particles.accelerations.at(0).x < 0.0F);
  REQUIRE(particles.accelerations.at(1).x == -particles.accelerations.at(0).x);
}

TEST_CASE("SPH reflects a particle at the container boundary", "[sim][sph]") {
  constexpr float timestep = 0.01F;
  constexpr float start_x = 0.94F;
  constexpr float start_speed = 2.0F;
  constexpr float expected_x = 0.95F;

  grav::Simulation sim;
  sim.params.force_model = grav::ForceModel::Sph;
  sim.params.dt = timestep;
  sim.params.gravity = 0.0F;
  resize_particles(sim.particles, 1);
  sim.particles.positions.at(0).x = start_x;
  sim.particles.velocities.at(0).x = start_speed;
  grav::step(sim);
  REQUIRE(sim.particles.positions.at(0).x == expected_x);
  REQUIRE(sim.particles.velocities.at(0).x < 0.0F);
}

TEST_CASE("Coulomb forces respect charge sign and conserve pair momentum", "[sim][charge]") {
  constexpr float spacing = 0.1F;
  constexpr float heavy_mass = 2.0F;
  constexpr float merge_radius = 0.21F;

  grav::Simulation sim;
  sim.params.force_model = grav::ForceModel::Electrostatic;
  sim.params.dt = 0.0F;
  auto& particles = sim.particles;
  resize_particles(particles, 3);
  particles.positions = {
      {.x = -spacing, .y = 0.0F, .z = 0.0F},
      {.x = spacing, .y = 0.0F, .z = 0.0F},
      {.x = 0.0F, .y = spacing, .z = 0.0F},
  };
  particles.masses = {1.0F, heavy_mass, 1.0F};
  particles.charges = {1.0F, 1.0F, 0.0F};
  grav::step(sim);
  const auto repulsion = particles.accelerations.at(0).x;
  REQUIRE(repulsion < 0.0F);
  REQUIRE(particles.accelerations.at(1).x * particles.masses.at(1) == -repulsion);
  REQUIRE(grav::length_squared(particles.accelerations.at(2)) == 0.0F);

  particles.charges.at(1) = -1.0F;
  grav::step(sim);
  REQUIRE(particles.accelerations.at(0).x == -repulsion);

  sim.params.merge_on_collision = true;
  sim.params.merge_radius = merge_radius;
  grav::step(sim);
  REQUIRE(count_particles(particles) == 1);
  REQUIRE(charge_of(particles, 0) == 0.0F);
}
