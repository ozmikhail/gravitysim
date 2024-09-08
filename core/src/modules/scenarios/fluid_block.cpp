#include "modules/scenarios/scenarios.h"

#include <cmath>

#include "modules/sim/particles.h"

namespace grav::scenarios {

void fluid_block(Particles& out, std::size_t n) {
    out.resize(n);
    if (n == 0) {
        return;
    }

    const auto side = static_cast<std::size_t>(std::ceil(std::cbrt(static_cast<double>(n))));
    constexpr Vec3 extent{0.8F, 0.9F, 0.75F};
    const float mass = extent.x * extent.y * extent.z / static_cast<float>(n);
    const auto lattice = [side](std::size_t i) {
        return (static_cast<float>(i) + 0.5F) / static_cast<float>(side);
    };
    for (std::size_t i = 0; i < n; ++i) {
        out.positions[i] = {
            -0.9F + extent.x * lattice(i % side),
            -0.9F + extent.y * lattice(i / (side * side)),
            -0.375F + extent.z * lattice((i / side) % side),
        };
        out.masses[i] = mass;
    }
}

}
