#include "modules/scenarios/scenarios.h"
#include "modules/sim/particles.h"

#include <algorithm>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <numbers>
#include <random>

namespace grav::scenarios {

void random_cluster(Particles& out, std::size_t n, Seed seed) {
  resize_particles(out, n);
  if (n == 0) {
    return;
  }

  constexpr float radius = 0.45F;
  constexpr float total_mass = 1.0F;
  const float per_mass = total_mass / static_cast<float>(n);
  const float v_sigma = 0.40F * std::sqrt(total_mass / radius);
  const float two_pi = 2.0F * std::numbers::pi_v<float>;

  std::mt19937_64 rng(static_cast<std::uint64_t>(seed));
  std::uniform_real_distribution<float> u_dist(0.0F, 1.0F);
  std::uniform_real_distribution<float> cos_theta_dist(-1.0F, 1.0F);
  std::uniform_real_distribution<float> phi_dist(0.0F, two_pi);
  std::normal_distribution<float> v_normal(0.0F, v_sigma);

  for (std::size_t i = 0; i < n; ++i) {
    const float dist = radius * std::cbrt(u_dist(rng));
    const float cos_theta = cos_theta_dist(rng);
    const float sin_theta = std::sqrt(std::max(0.0F, 1.0F - (cos_theta * cos_theta)));
    const float phi = phi_dist(rng);

    out.positions.at(i) = {
        .x = dist * sin_theta * std::cos(phi),
        .y = dist * sin_theta * std::sin(phi),
        .z = dist * cos_theta,
    };
    out.velocities.at(i) = {
        .x = v_normal(rng),
        .y = v_normal(rng),
        .z = v_normal(rng),
    };
    out.masses.at(i) = per_mass;
  }
}

} // namespace grav::scenarios
