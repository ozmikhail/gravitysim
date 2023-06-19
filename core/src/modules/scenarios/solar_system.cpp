#include "modules/scenarios/scenarios.h"

#include <array>
#include <cmath>

#include "modules/sim/particles.h"

namespace grav::scenarios {

namespace {

struct Body {
    float orbit_radius;
    float mass;
};

constexpr float kSunMass = 1.0F;
constexpr float kSofteningSq = 0.08F * 0.08F;

constexpr std::array<Body, 9> kBodies = {{
    {0.00F, kSunMass},
    {0.10F, 0.00030F},
    {0.14F, 0.00040F},
    {0.18F, 0.00050F},
    {0.22F, 0.00035F},
    {0.28F, 0.00300F},
    {0.32F, 0.00200F},
    {0.38F, 0.00100F},
    {0.44F, 0.00090F},
}};

}

void solar_system(Particles& out) {
    out.resize(kBodies.size());

    std::size_t i = 0;
    for (const auto& body : kBodies) {
        const float angle = 0.6F * static_cast<float>(i);
        const float r = body.orbit_radius;
        out.positions[i] = {r * std::cos(angle), r * std::sin(angle), 0.0F};
        out.masses[i] = body.mass;

        if (i == 0) {
            out.velocities[i] = {0.0F, 0.0F, 0.0F};
        } else {
            const float r2 = r * r;
            const float r2_eps = r2 + kSofteningSq;
            const float v = std::sqrt(kSunMass * r2 / (r2_eps * std::sqrt(r2_eps)));
            out.velocities[i] = {-v * std::sin(angle), v * std::cos(angle), 0.0F};
        }
        ++i;
    }

    Vec3 com_pos{};
    Vec3 com_vel{};
    float total_mass = 0.0F;
    for (std::size_t k = 0; k < out.count(); ++k) {
        com_pos += out.positions[k] * out.masses[k];
        com_vel += out.velocities[k] * out.masses[k];
        total_mass += out.masses[k];
    }
    com_pos = com_pos * (1.0F / total_mass);
    com_vel = com_vel * (1.0F / total_mass);
    for (std::size_t k = 0; k < out.count(); ++k) {
        out.positions[k] -= com_pos;
        out.velocities[k] -= com_vel;
    }
}

}
