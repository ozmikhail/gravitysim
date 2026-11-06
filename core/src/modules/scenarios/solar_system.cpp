#include "modules/scenarios/scenarios.h"
#include "modules/sim/particles.h"

#include <array>
#include <cmath>
#include <cstddef>

namespace grav::scenarios {

namespace {

struct Body {
  float orbit_radius;
  float mass;
};

constexpr float SUN_MASS = 1.0F;
constexpr float SOFTENING_SQ = 0.08F * 0.08F;

constexpr std::array<Body, 9> BODIES = {
    {
        {.orbit_radius = 0.00F, .mass = SUN_MASS},
        {.orbit_radius = 0.10F, .mass = 0.00030F},
        {.orbit_radius = 0.14F, .mass = 0.00040F},
        {.orbit_radius = 0.18F, .mass = 0.00050F},
        {.orbit_radius = 0.22F, .mass = 0.00035F},
        {.orbit_radius = 0.28F, .mass = 0.00300F},
        {.orbit_radius = 0.32F, .mass = 0.00200F},
        {.orbit_radius = 0.38F, .mass = 0.00100F},
        {.orbit_radius = 0.44F, .mass = 0.00090F},
    },
};

} // namespace

void solar_system(Particles& out) {
  resize_particles(out, BODIES.size());

  std::size_t index = 0;
  for (const auto& body : BODIES) {
    const float angle = 0.6F * static_cast<float>(index);
    const float orbit = body.orbit_radius;
    out.positions.at(index) = {
        .x = orbit * std::cos(angle),
        .y = orbit * std::sin(angle),
        .z = 0.0F,
    };
    out.masses.at(index) = body.mass;

    if (index == 0) {
      out.velocities.at(index) = {.x = 0.0F, .y = 0.0F, .z = 0.0F};
    } else {
      const float dist_sq = orbit * orbit;
      const float dist_sq_eps = dist_sq + SOFTENING_SQ;
      const float speed = std::sqrt(SUN_MASS * dist_sq / (dist_sq_eps * std::sqrt(dist_sq_eps)));
      out.velocities.at(index) = {
          .x = -speed * std::sin(angle),
          .y = speed * std::cos(angle),
          .z = 0.0F,
      };
    }
    ++index;
  }

  Vec3 com_pos{};
  Vec3 com_vel{};
  float total_mass = 0.0F;
  for (std::size_t k = 0; k < count_particles(out); ++k) {
    com_pos += out.positions.at(k) * out.masses.at(k);
    com_vel += out.velocities.at(k) * out.masses.at(k);
    total_mass += out.masses.at(k);
  }
  com_pos = com_pos * (1.0F / total_mass);
  com_vel = com_vel * (1.0F / total_mass);
  for (std::size_t k = 0; k < count_particles(out); ++k) {
    out.positions.at(k) -= com_pos;
    out.velocities.at(k) -= com_vel;
  }
}

} // namespace grav::scenarios
