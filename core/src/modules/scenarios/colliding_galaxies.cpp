#include "modules/scenarios/scenarios.h"

#include <algorithm>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <numbers>
#include <random>

#include "modules/sim/particles.h"

namespace grav::scenarios {

namespace {

void seed_galaxy(
    Particles& out,
    std::size_t base,
    std::size_t n,
    Vec3 center,
    Vec3 bulk_velocity,
    float radius,
    float spin,
    std::mt19937_64& rng
) {
    constexpr float kCoreMass = 1.0F;
    constexpr float kSatelliteTotalMass = 0.4F;
    constexpr float kSofteningSq = 0.08F * 0.08F;
    constexpr float kInnerRadiusFrac = 0.15F;
    const float satellite_mass =
        n > 1 ? kSatelliteTotalMass / static_cast<float>(n - 1) : 0.0F;

    std::uniform_real_distribution<float> radial(0.0F, 1.0F);
    std::uniform_real_distribution<float> phi_dist(
        0.0F, 2.0F * std::numbers::pi_v<float>
    );
    std::normal_distribution<float> z_normal(0.0F, 0.01F);

    out.positions[base] = center;
    out.velocities[base] = bulk_velocity;
    out.masses[base] = kCoreMass;

    const float r_min = radius * kInnerRadiusFrac;
    const float r_span = radius - r_min;

    for (std::size_t i = 1; i < n; ++i) {
        const float r = r_min + (r_span * std::sqrt(radial(rng)));
        const float phi = phi_dist(rng);
        const float x = r * std::cos(phi);
        const float y = r * std::sin(phi);
        const float z = z_normal(rng);

        out.positions[base + i] = {center.x + x, center.y + y, center.z + z};
        out.masses[base + i] = satellite_mass;

        const float r2 = r * r;
        const float r2_eps = r2 + kSofteningSq;
        const float orbit_speed = std::sqrt(kCoreMass * r2 / (r2_eps * std::sqrt(r2_eps)));
        const float vx = -spin * orbit_speed * std::sin(phi);
        const float vy = spin * orbit_speed * std::cos(phi);
        out.velocities[base + i] = {
            bulk_velocity.x + vx,
            bulk_velocity.y + vy,
            bulk_velocity.z,
        };
    }
}

}

void colliding_galaxies(Particles& out, std::size_t per_galaxy, std::uint64_t seed) {
    per_galaxy = std::max<std::size_t>(per_galaxy, 2);
    out.resize(per_galaxy * 2);

    std::mt19937_64 rng(seed);
    seed_galaxy(
        out, 0, per_galaxy,
        {-0.30F, 0.00F, 0.00F}, {0.20F, 0.00F, 0.00F},
        0.18F, +1.0F, rng
    );
    seed_galaxy(
        out, per_galaxy, per_galaxy,
        {0.30F, 0.05F, 0.00F}, {-0.20F, -0.05F, 0.00F},
        0.18F, -1.0F, rng
    );
}

}
