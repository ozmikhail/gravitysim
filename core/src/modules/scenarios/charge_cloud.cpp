#include "modules/scenarios/scenarios.h"

#include "modules/sim/particles.h"

namespace grav::scenarios {

void charge_cloud(Particles& out, std::size_t n) {
    random_cluster(out, n, 73);
    for (std::size_t i = 0; i < n; ++i) {
        const float sign = i % 2 == 0 ? 1.0F : -1.0F;
        out.charges[i] = sign * 2.0F * out.masses[i];
        out.velocities[i] = out.velocities[i] * 0.08F;
    }
}

}
