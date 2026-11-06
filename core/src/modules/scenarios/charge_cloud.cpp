#include "modules/scenarios/scenarios.h"
#include "modules/sim/particles.h"

#include <cstddef>
#include <cstdint>

namespace grav::scenarios {

namespace {
constexpr std::uint64_t CHARGE_CLOUD_SEED = 73;
constexpr float CHARGE_MASS_FACTOR = 2.0F;
constexpr float CHARGE_CLOUD_VELOCITY_SCALE = 0.08F;
} // namespace

void charge_cloud(Particles& out, std::size_t n) {
  random_cluster(out, n, Seed{CHARGE_CLOUD_SEED});
  for (std::size_t i = 0; i < n; ++i) {
    const float sign = i % 2 == 0 ? 1.0F : -1.0F;
    out.charges.at(i) = sign * CHARGE_MASS_FACTOR * out.masses.at(i);
    out.velocities.at(i) = out.velocities.at(i) * CHARGE_CLOUD_VELOCITY_SCALE;
  }
}

} // namespace grav::scenarios
