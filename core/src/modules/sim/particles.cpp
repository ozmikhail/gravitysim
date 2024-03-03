#include "modules/sim/particles.h"

#include <numeric>

namespace grav {

void Particles::resize(std::size_t n) {
    positions.assign(n, Vec3{});
    velocities.assign(n, Vec3{});
    accelerations.assign(n, Vec3{});
    masses.assign(n, 1.0F);
    ids.resize(n);
    std::iota(ids.begin(), ids.end(), std::size_t{0});
}

void Particles::clear() {
    positions.clear();
    velocities.clear();
    accelerations.clear();
    masses.clear();
    ids.clear();
}

}
