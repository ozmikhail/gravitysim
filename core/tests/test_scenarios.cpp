#include "modules/scenarios/scenarios.h"
#include "modules/sim/particles.h"

#include <catch2/catch_test_macros.hpp>
#include <cstddef>
#include <cstdint>

TEST_CASE("solar_system seeds nine bodies with sun dominating", "[scenarios]") {
  grav::Particles particles;
  grav::scenarios::solar_system(particles);

  REQUIRE(count_particles(particles) == 9);
  const float sun_mass = particles.masses.at(0);
  for (std::size_t i = 1; i < count_particles(particles); ++i) {
    REQUIRE(sun_mass > particles.masses.at(i));
  }
}

TEST_CASE("random_cluster lies within unit sphere", "[scenarios]") {
  constexpr std::size_t body_count = 256;
  constexpr std::uint64_t seed = 7;

  grav::Particles particles;
  grav::scenarios::random_cluster(particles, body_count, grav::scenarios::Seed{seed});

  REQUIRE(count_particles(particles) == 256);
  for (std::size_t i = 0; i < count_particles(particles); ++i) {
    REQUIRE(grav::length(particles.positions.at(i)) <= 1.0F);
  }
}

TEST_CASE("colliding_galaxies has 2N particles total", "[scenarios]") {
  constexpr std::size_t per_galaxy = 128;
  constexpr std::uint64_t seed = 13;

  grav::Particles particles;
  grav::scenarios::colliding_galaxies(particles, per_galaxy, grav::scenarios::Seed{seed});

  REQUIRE(count_particles(particles) == 256);
}

TEST_CASE("random_cluster is reproducible by seed", "[scenarios]") {
  constexpr std::size_t body_count = 32;
  constexpr std::uint64_t seed = 99;

  grav::Particles first;
  grav::Particles second;
  grav::scenarios::random_cluster(first, body_count, grav::scenarios::Seed{seed});
  grav::scenarios::random_cluster(second, body_count, grav::scenarios::Seed{seed});

  REQUIRE(count_particles(first) == count_particles(second));
  for (std::size_t i = 0; i < count_particles(first); ++i) {
    REQUIRE(first.positions.at(i).x == second.positions.at(i).x);
    REQUIRE(first.positions.at(i).y == second.positions.at(i).y);
    REQUIRE(first.positions.at(i).z == second.positions.at(i).z);
  }
}
