#include "modules/sim/collisions.h"

#include "modules/sim/particles.h"

#include <algorithm>
#include <cmath>
#include <cstddef>
#include <numeric>
#include <utility>
#include <vector>

namespace grav {

namespace {

int root_of(std::vector<int>& parents, int index) {
  while (parents.at(index) != index) {
    parents.at(index) = parents.at(parents.at(index));
    index = parents.at(index);
  }
  return index;
}

} // namespace

void merge_collision_groups(Particles& particles, std::vector<int>& parents) {
  const auto particle_count = count_particles(particles);
  particles.accelerations.resize(particle_count);
  particles.charges.resize(particle_count, 0.0F);
  if (particles.ids.size() != particle_count) {
    particles.ids.resize(particle_count);
    std::iota(particles.ids.begin(), particles.ids.end(), std::size_t{0});
  }

  for (std::size_t i = 0; i < particle_count; ++i) {
    const int root = parents.at(parents.at(i));
    parents.at(i) = root;
    if (std::cmp_equal(root, i)) {
      continue;
    }

    const float mass = particles.masses.at(root) + particles.masses.at(i);
    if (mass != 0.0F) {
      const float fraction = particles.masses.at(i) / mass;
      particles.positions.at(root) +=
          (particles.positions.at(i) - particles.positions.at(root)) * fraction;
      particles.velocities.at(root) +=
          (particles.velocities.at(i) - particles.velocities.at(root)) * fraction;
    }
    particles.masses.at(root) = mass;
    particles.charges.at(root) += particles.charges.at(i);
    particles.accelerations.at(root) = {};
  }

  std::size_t out = 0;
  for (std::size_t i = 0; i < particle_count; ++i) {
    if (std::cmp_not_equal(parents.at(i), i)) {
      continue;
    }
    particles.positions.at(out) = particles.positions.at(i);
    particles.velocities.at(out) = particles.velocities.at(i);
    particles.accelerations.at(out) = particles.accelerations.at(i);
    particles.masses.at(out) = particles.masses.at(i);
    particles.charges.at(out) = particles.charges.at(i);
    particles.ids.at(out) = particles.ids.at(i);
    ++out;
  }
  particles.positions.resize(out);
  particles.velocities.resize(out);
  particles.accelerations.resize(out);
  particles.masses.resize(out);
  particles.charges.resize(out);
  particles.ids.resize(out);
}

void merge_collisions(Particles& particles, float radius) {
  if (radius <= 0.0F || count_particles(particles) < 2) {
    return;
  }

  std::vector<int> order;
  order.reserve(count_particles(particles));
  for (std::size_t i = 0; i < count_particles(particles); ++i) {
    if (std::isfinite(particles.positions.at(i).x)) {
      order.push_back(static_cast<int>(i));
    }
  }
  std::ranges::sort(order, [&](int lhs, int rhs) {
    return particles.positions.at(lhs).x < particles.positions.at(rhs).x;
  });
  std::vector<int> parents(count_particles(particles));
  std::iota(parents.begin(), parents.end(), 0);

  const float radius_sq = radius * radius;
  bool merged = false;
  for (std::size_t outer = 0; outer < order.size(); ++outer) {
    const int lhs = order.at(outer);
    for (std::size_t inner = outer + 1; inner < order.size(); ++inner) {
      const int rhs = order.at(inner);
      const Vec3 delta = particles.positions.at(rhs) - particles.positions.at(lhs);
      if (delta.x > radius) {
        break;
      }
      if (length_squared(delta) <= radius_sq) {
        const int first = root_of(parents, lhs);
        const int second = root_of(parents, rhs);
        parents.at(std::max(first, second)) = std::min(first, second);
        merged = true;
      }
    }
  }

  if (merged) {
    merge_collision_groups(particles, parents);
  }
}

} // namespace grav
