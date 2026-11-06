#include "modules/scenarios/scenarios.h"
#include "modules/sim/particles.h"

#include <algorithm>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <numbers>
#include <random>

namespace grav::scenarios {

namespace {

constexpr float Z_SCATTER = 0.01F;

void seed_galaxy(Particles& out, std::size_t base, Vec3 center, float radius, Vec3 bulk_velocity,
                 std::size_t n, std::mt19937_64& rng, float spin) {
  constexpr float core_mass = 1.0F;
  constexpr float satellite_total_mass = 0.4F;
  constexpr float softening_sq = 0.08F * 0.08F;
  constexpr float inner_radius_frac = 0.15F;
  const float satellite_mass = n > 1 ? satellite_total_mass / static_cast<float>(n - 1) : 0.0F;
  const float two_pi = 2.0F * std::numbers::pi_v<float>;

  std::uniform_real_distribution<float> radial(0.0F, 1.0F);
  std::uniform_real_distribution<float> phi_dist(0.0F, two_pi);
  std::normal_distribution<float> z_normal(0.0F, Z_SCATTER);

  out.positions.at(base) = center;
  out.velocities.at(base) = bulk_velocity;
  out.masses.at(base) = core_mass;

  const float r_min = radius * inner_radius_frac;
  const float r_span = radius - r_min;

  for (std::size_t i = 1; i < n; ++i) {
    const float dist = r_min + (r_span * std::sqrt(radial(rng)));
    const float phi = phi_dist(rng);
    const float off_x = dist * std::cos(phi);
    const float off_y = dist * std::sin(phi);
    const float off_z = z_normal(rng);

    out.positions.at(base + i) = {
        .x = center.x + off_x,
        .y = center.y + off_y,
        .z = center.z + off_z,
    };
    out.masses.at(base + i) = satellite_mass;

    const float dist_sq = dist * dist;
    const float dist_sq_eps = dist_sq + softening_sq;
    const float orbit_speed =
        std::sqrt(core_mass * dist_sq / (dist_sq_eps * std::sqrt(dist_sq_eps)));
    const float vel_x = -spin * orbit_speed * std::sin(phi);
    const float vel_y = spin * orbit_speed * std::cos(phi);
    out.velocities.at(base + i) = {
        .x = bulk_velocity.x + vel_x,
        .y = bulk_velocity.y + vel_y,
        .z = bulk_velocity.z,
    };
  }
}

} // namespace

void colliding_galaxies(Particles& out, std::size_t per_galaxy, Seed seed) {
  per_galaxy = std::max<std::size_t>(per_galaxy, 2);
  resize_particles(out, per_galaxy * 2);

  constexpr Vec3 first_center{.x = -0.30F, .y = 0.00F, .z = 0.00F};
  constexpr Vec3 first_velocity{.x = 0.20F, .y = 0.00F, .z = 0.00F};
  constexpr float first_radius = 0.18F;
  constexpr Vec3 second_center{.x = 0.30F, .y = 0.05F, .z = 0.00F};
  constexpr Vec3 second_velocity{.x = -0.20F, .y = -0.05F, .z = 0.00F};
  constexpr float second_radius = 0.18F;

  std::mt19937_64 rng(static_cast<std::uint64_t>(seed));
  seed_galaxy(out, 0, first_center, first_radius, first_velocity, per_galaxy, rng, +1.0F);
  seed_galaxy(out, per_galaxy, second_center, second_radius, second_velocity, per_galaxy, rng,
              -1.0F);
}

} // namespace grav::scenarios
