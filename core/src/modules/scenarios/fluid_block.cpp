#include "modules/scenarios/scenarios.h"
#include "modules/sim/particles.h"

#include <cmath>
#include <cstddef>

namespace grav::scenarios {

namespace {
constexpr float LATTICE_CENTER_OFFSET = 0.5F;
constexpr float BLOCK_HALF_XY = 0.9F;
constexpr float BLOCK_HALF_Z = 0.375F;
} // namespace

void fluid_block(Particles& out, std::size_t n) {
  resize_particles(out, n);
  if (n == 0) {
    return;
  }

  const auto side = static_cast<std::size_t>(std::ceil(std::cbrt(static_cast<double>(n))));
  constexpr Vec3 extent{.x = 0.8F, .y = 0.9F, .z = 0.75F};
  const float mass = extent.x * extent.y * extent.z / static_cast<float>(n);
  const auto lattice = [side](std::size_t index) {
    return (static_cast<float>(index) + LATTICE_CENTER_OFFSET) / static_cast<float>(side);
  };
  for (std::size_t i = 0; i < n; ++i) {
    out.positions.at(i) = {
        .x = -BLOCK_HALF_XY + (extent.x * lattice(i % side)),
        .y = -BLOCK_HALF_XY + (extent.y * lattice(i / (side * side))),
        .z = -BLOCK_HALF_Z + (extent.z * lattice((i / side) % side)),
    };
    out.masses.at(i) = mass;
  }
}

} // namespace grav::scenarios
