#ifndef GRAV_LIB_OPENMP_GRAVITY_FORCE_H
#define GRAV_LIB_OPENMP_GRAVITY_FORCE_H

#include "modules/sim/particles.h"

namespace grav {

inline Vec3 softened_acceleration(float strength, Vec3 delta, float softening_sq) {
  const float dist_sq = length_squared(delta) + softening_sq;
  if (dist_sq == 0.0F) {
    return {};
  }
  const float inv_r3 = 1.0F / (dist_sq * std::sqrt(dist_sq));
  return delta * (strength * inv_r3);
}

} // namespace grav

#endif // GRAV_LIB_OPENMP_GRAVITY_FORCE_H
