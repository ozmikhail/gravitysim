#include "lib/openmp/sph.h"

#include "modules/sim/params.h"
#include "modules/sim/particles.h"

#include <algorithm>
#include <array>
#include <cmath>
#include <cstddef>
#include <numbers>
#include <unordered_map>
#include <vector>

namespace grav {

namespace {

constexpr float WALL = 0.95F;
constexpr float RESTITUTION = 0.35F;
constexpr float MIN_DENSITY = 1e-6F;
constexpr std::size_t HASH_PRIME_X = 73856093U;
constexpr std::size_t HASH_PRIME_Y = 19349663U;
constexpr std::size_t HASH_PRIME_Z = 83492791U;

using Cell = std::array<int, 3>;

struct CellHash {
  std::size_t operator()(const Cell& cell) const noexcept {
    const auto& [cell_x, cell_y, cell_z] = cell;
    return (static_cast<std::size_t>(cell_x) * HASH_PRIME_X) ^
           (static_cast<std::size_t>(cell_y) * HASH_PRIME_Y) ^
           (static_cast<std::size_t>(cell_z) * HASH_PRIME_Z);
  }
};

class NeighborGrid {
public:
  NeighborGrid(const Particles& particles, float cell_size) : cell_size_(cell_size) {
    for (std::size_t i = 0; i < count_particles(particles); ++i) {
      cells_[cell_at(particles.positions.at(i))].push_back(i);
    }
  }

  template <typename Visit> void visit(Vec3 position, Visit visit_particle) const {
    const auto [home_x, home_y, home_z] = cell_at(position);
    for (int grid_x = home_x - 1; grid_x <= home_x + 1; ++grid_x) {
      for (int grid_y = home_y - 1; grid_y <= home_y + 1; ++grid_y) {
        for (int grid_z = home_z - 1; grid_z <= home_z + 1; ++grid_z) {
          const auto bucket = cells_.find({grid_x, grid_y, grid_z});
          if (bucket != cells_.end()) {
            for (const auto index : bucket->second) {
              visit_particle(index);
            }
          }
        }
      }
    }
  }

private:
  [[nodiscard]] Cell cell_at(Vec3 position) const {
    const auto cell_coord = [this](float coord) {
      // Bound the grid even if a scene starts outside the fluid box.
      const float clamped = std::max(-WALL, std::min(WALL, coord));
      return static_cast<int>(std::floor(clamped / cell_size_));
    };
    return {cell_coord(position.x), cell_coord(position.y), cell_coord(position.z)};
  }

  float cell_size_;
  std::unordered_map<Cell, std::vector<std::size_t>, CellHash> cells_;
};

void bounce(Vec3& position, float Vec3::* axis, Vec3& velocity) {
  float& coord = position.*axis;
  float& speed = velocity.*axis;
  if (coord > WALL) {
    coord = WALL;
    if (speed > 0.0F) {
      speed *= -RESTITUTION;
    }
  } else if (coord < -WALL) {
    coord = -WALL;
    if (speed < 0.0F) {
      speed *= -RESTITUTION;
    }
  }
}

} // namespace

void compute_sph(Particles& particles, const SimParams& params) {
  const std::size_t count = count_particles(particles);
  const float radius = std::max(0.02F, std::min(0.5F, params.sph_radius));
  const float radius_sq = radius * radius;
  const float radius_pow6 = radius_sq * radius_sq * radius_sq;
  const float poly6 =
      315.0F / (64.0F * std::numbers::pi_v<float> * radius_pow6 * radius_sq * radius);
  const float spiky = 45.0F / (std::numbers::pi_v<float> * radius_pow6);
  const NeighborGrid grid(particles, radius);
  std::vector<float> density(count);
  std::vector<float> pressure_term(count);

#pragma omp parallel for schedule(static) default(none)                                            \
    shared(particles, params, count, radius_sq, poly6, grid, density, pressure_term)
  for (std::size_t i = 0; i < count; ++i) {
    const Vec3 position = particles.positions.at(i);
    float rho = 0.0F;
    grid.visit(position, [&](std::size_t neighbor) {
      const float falloff = radius_sq - length_squared(particles.positions.at(neighbor) - position);
      if (falloff > 0.0F) {
        rho += particles.masses.at(neighbor) * poly6 * falloff * falloff * falloff;
      }
    });
    rho = std::max(rho, MIN_DENSITY);
    density.at(i) = rho;
    const float pressure = params.sph_stiffness * std::max(0.0F, rho - params.sph_rest_density);
    pressure_term.at(i) = pressure / (rho * rho);
  }

#pragma omp parallel for schedule(static) default(none)                                            \
    shared(particles, params, count, radius, radius_sq, spiky, grid, density, pressure_term)
  for (std::size_t i = 0; i < count; ++i) {
    const Vec3 position = particles.positions.at(i);
    Vec3 acc{.x = 0.0F, .y = -params.gravity, .z = 0.0F};
    grid.visit(position, [&](std::size_t neighbor) {
      const Vec3 delta = particles.positions.at(neighbor) - position;
      const float dist_sq = length_squared(delta);
      if (neighbor == i || !(dist_sq < radius_sq)) {
        return;
      }
      const float dist = std::sqrt(dist_sq);
      const float overlap = radius - dist;
      const float weight = particles.masses.at(neighbor) * spiky * overlap;
      if (dist > 0.0F) {
        acc -=
            delta * (weight * overlap * (pressure_term.at(i) + pressure_term.at(neighbor)) / dist);
      }
      const float visc =
          2.0F * params.sph_viscosity * weight / (density.at(i) + density.at(neighbor));
      acc += (particles.velocities.at(neighbor) - particles.velocities.at(i)) * visc;
    });
    particles.accelerations.at(i) = acc;
  }
}

void confine_fluid(Particles& particles) {
  for (std::size_t i = 0; i < count_particles(particles); ++i) {
    auto& position = particles.positions.at(i);
    auto& velocity = particles.velocities.at(i);
    bounce(position, &Vec3::x, velocity);
    bounce(position, &Vec3::y, velocity);
    bounce(position, &Vec3::z, velocity);
  }
}

} // namespace grav
