#pragma once

#include "modules/sim/particles.h"

namespace grav {

inline Vec3 softened_acceleration(Vec3 delta, float strength, float softening_sq) {
    const float r2 = length_squared(delta) + softening_sq;
    if (r2 == 0.0F) {
        return {};
    }
    const float inv_r3 = 1.0F / (r2 * std::sqrt(r2));
    return delta * (strength * inv_r3);
}

}
