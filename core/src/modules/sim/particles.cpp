#include "modules/sim/particles.h"

#include <cstddef>
#include <numeric>

namespace grav {

void resize_particles(Particles& particles, std::size_t count) {
  particles.positions.assign(count, Vec3{});
  particles.velocities.assign(count, Vec3{});
  particles.accelerations.assign(count, Vec3{});
  particles.masses.assign(count, 1.0F);
  particles.charges.assign(count, 0.0F);
  particles.ids.resize(count);
  std::iota(particles.ids.begin(), particles.ids.end(), std::size_t{0});
}

void clear_particles(Particles& particles) {
  particles.positions.clear();
  particles.velocities.clear();
  particles.accelerations.clear();
  particles.masses.clear();
  particles.charges.clear();
  particles.ids.clear();
}

} // namespace grav
