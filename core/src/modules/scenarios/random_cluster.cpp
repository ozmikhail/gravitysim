#include "modules/scenarios/scenarios.h"

#include <cmath>
#include <cstddef>
#include <cstdint>
#include <numbers>
#include <random>

#include "modules/sim/particles.h"

namespace grav::scenarios {

void random_cluster(Particles& out, std::size_t n, std::uint64_t seed) {
    out.resize(n);
    if (n == 0) {
        return;
    }

    constexpr float kRadius = 0.45F;
    constexpr float kTotalMass = 1.0F;
    const float per_mass = kTotalMass / static_cast<float>(n);
    const float v_sigma = 0.40F * std::sqrt(kTotalMass / kRadius);

    std::mt19937_64 rng(seed);
    std::uniform_real_distribution<float> u_dist(0.0F, 1.0F);
    std::uniform_real_distribution<float> cos_theta_dist(-1.0F, 1.0F);
    std::uniform_real_distribution<float> phi_dist(
        0.0F, 2.0F * std::numbers::pi_v<float>
    );
    std::normal_distribution<float> v_normal(0.0F, v_sigma);

    for (std::size_t i = 0; i < n; ++i) {
        const float r = kRadius * std::cbrt(u_dist(rng));
        const float cos_theta = cos_theta_dist(rng);
        const float sin_theta = std::sqrt(std::max(0.0F, 1.0F - (cos_theta * cos_theta)));
        const float phi = phi_dist(rng);

        out.positions[i] = {
            r * sin_theta * std::cos(phi),
            r * sin_theta * std::sin(phi),
            r * cos_theta,
        };
        out.velocities[i] = {v_normal(rng), v_normal(rng), v_normal(rng)};
        out.masses[i] = per_mass;
    }
}

}
