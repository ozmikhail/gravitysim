#include "lib/openmp/barnes_hut.h"

#include "lib/openmp/gravity_force.h"
#include "modules/sim/params.h"
#include "modules/sim/particles.h"

#include <algorithm>
#include <array>
#include <cstddef>
#include <numeric>
#include <optional>
#include <vector>

namespace grav {

namespace {

constexpr std::size_t OCTANTS = 8;
constexpr std::size_t LEAF_CAPACITY = 8;
constexpr int MAX_DEPTH = 24;

std::size_t octant(Vec3 point, Vec3 center) {
  const auto bit = [](bool set, std::size_t value) { return set ? value : std::size_t{0}; };
  return bit(point.x >= center.x, 1U) | bit(point.y >= center.y, 2U) | bit(point.z >= center.z, 4U);
}

struct Node {
  std::size_t begin;
  std::size_t end;
  float half_width;
  std::array<int, OCTANTS> children{-1, -1, -1, -1, -1, -1, -1, -1};
  Vec3 center_of_mass{};
  float mass = 0.0F;
  bool leaf = true;
  bool coincident = true;
};

struct BuildTask {
  std::size_t begin;
  std::size_t end;
  Vec3 center;
  float half_width;
  int depth;
  int parent;
  std::size_t slot;
};

struct WalkParams {
  float gravity;
  float eps2;
  float theta_sq;
};

struct WalkFrame {
  int index;
  std::size_t next_child;
  Vec3 sum;
};

void push_children(std::vector<BuildTask>& pending, const BuildTask& task, int index,
                   const std::array<std::size_t, OCTANTS>& counts,
                   const std::array<std::size_t, OCTANTS + 1>& offsets) {
  const float child_half = task.half_width * 0.5F;
  for (std::size_t k = OCTANTS; k-- > 0;) {
    if (counts.at(k) == 0) {
      continue;
    }
    const Vec3 child_center = {
        .x = task.center.x + ((k & 1U) != 0 ? child_half : -child_half),
        .y = task.center.y + ((k & 2U) != 0 ? child_half : -child_half),
        .z = task.center.z + ((k & 4U) != 0 ? child_half : -child_half),
    };
    pending.push_back(BuildTask{
        .begin = offsets.at(k),
        .end = offsets.at(k + 1),
        .center = child_center,
        .half_width = child_half,
        .depth = task.depth + 1,
        .parent = index,
        .slot = k,
    });
  }
}

class Octree {
public:
  explicit Octree(const Particles& particles)
      : particles_(&particles), order_(count_particles(particles)),
        rank_(count_particles(particles)) {
    std::iota(order_.begin(), order_.end(), std::size_t{0});
    std::vector<std::size_t> scratch(order_.size());
    Vec3 low = particles.positions.front();
    Vec3 high = low;
    for (const Vec3 position : particles.positions) {
      low = {
          .x = std::min(low.x, position.x),
          .y = std::min(low.y, position.y),
          .z = std::min(low.z, position.z),
      };
      high = {
          .x = std::max(high.x, position.x),
          .y = std::max(high.y, position.y),
          .z = std::max(high.z, position.z),
      };
    }
    const Vec3 center = {
        .x = std::midpoint(low.x, high.x),
        .y = std::midpoint(low.y, high.y),
        .z = std::midpoint(low.z, high.z),
    };
    const float half_width = std::max({
        high.x - center.x,
        high.y - center.y,
        high.z - center.z,
        center.x - low.x,
        center.y - low.y,
        center.z - low.z,
    });
    build(center, half_width, scratch);
    for (std::size_t i = 0; i < order_.size(); ++i) {
      rank_.at(order_.at(i)) = i;
    }
  }

  [[nodiscard]] Vec3 acceleration(std::size_t particle, const WalkParams& params) const {
    const Vec3 position = particles_->positions.at(particle);
    if (const auto direct = contribution(nodes_.at(0), particle, position, params)) {
      return *direct;
    }
    std::vector<WalkFrame> frames{WalkFrame{.index = 0, .next_child = 0, .sum = {}}};
    for (;;) {
      WalkFrame& top = frames.back();
      if (top.next_child == OCTANTS) {
        const Vec3 finished = top.sum;
        frames.pop_back();
        if (frames.empty()) {
          return finished;
        }
        frames.back().sum += finished;
        continue;
      }
      const int child = nodes_.at(top.index).children.at(top.next_child);
      ++top.next_child;
      if (child < 0) {
        continue;
      }
      const Node& child_node = nodes_.at(child);
      if (const auto direct = contribution(child_node, particle, position, params)) {
        top.sum += *direct;
      } else {
        frames.push_back(WalkFrame{.index = child, .next_child = 0, .sum = {}});
      }
    }
  }

private:
  void build(Vec3 root_center, float root_half_width, std::vector<std::size_t>& scratch) {
    const BuildTask root{
        .begin = 0,
        .end = order_.size(),
        .center = root_center,
        .half_width = root_half_width,
        .depth = 0,
        .parent = -1,
        .slot = 0,
    };
    std::vector<BuildTask> pending{root};
    while (!pending.empty()) {
      const BuildTask task = pending.back();
      pending.pop_back();

      const int index = add_node(task);
      if (task.parent >= 0) {
        nodes_.at(task.parent).children.at(task.slot) = index;
      }
      if (task.end - task.begin <= LEAF_CAPACITY || nodes_.at(index).coincident ||
          task.depth == MAX_DEPTH || task.half_width == 0.0F) {
        continue;
      }

      const auto counts = count_octants(task);
      const auto offsets = partition_bodies(task, counts, scratch);
      nodes_.at(index).leaf = false;
      push_children(pending, task, index, counts, offsets);
    }
  }

  int add_node(const BuildTask& task) {
    Node node{.begin = task.begin, .end = task.end, .half_width = task.half_width};
    const Vec3 first = particles_->positions.at(order_.at(task.begin));
    double total_mass = 0.0;
    std::array<double, 3> weighted{};
    for (std::size_t k = task.begin; k < task.end; ++k) {
      const auto body = order_.at(k);
      const Vec3 position = particles_->positions.at(body);
      const double mass = particles_->masses.at(body);
      total_mass += mass;
      weighted.at(0) += mass * position.x;
      weighted.at(1) += mass * position.y;
      weighted.at(2) += mass * position.z;
      node.coincident &= position.x == first.x && position.y == first.y && position.z == first.z;
    }
    node.mass = static_cast<float>(total_mass);
    node.center_of_mass = total_mass == 0.0
                              ? first
                              : Vec3{
                                    .x = static_cast<float>(weighted.at(0) / total_mass),
                                    .y = static_cast<float>(weighted.at(1) / total_mass),
                                    .z = static_cast<float>(weighted.at(2) / total_mass),
                                };
    if (node.coincident) {
      node.center_of_mass = first;
    }
    const int index = static_cast<int>(nodes_.size());
    nodes_.push_back(node);
    return index;
  }

  [[nodiscard]] std::array<std::size_t, OCTANTS> count_octants(const BuildTask& task) const {
    std::array<std::size_t, OCTANTS> counts{};
    for (std::size_t k = task.begin; k < task.end; ++k) {
      ++counts.at(octant(particles_->positions.at(order_.at(k)), task.center));
    }
    return counts;
  }

  std::array<std::size_t, OCTANTS + 1>
  partition_bodies(const BuildTask& task, const std::array<std::size_t, OCTANTS>& counts,
                   std::vector<std::size_t>& scratch) {
    std::array<std::size_t, OCTANTS + 1> offsets{};
    offsets.at(0) = task.begin;
    for (std::size_t k = 0; k < OCTANTS; ++k) {
      offsets.at(k + 1) = offsets.at(k) + counts.at(k);
    }
    auto cursor = offsets;
    for (std::size_t k = task.begin; k < task.end; ++k) {
      const auto body = order_.at(k);
      scratch.at(cursor.at(octant(particles_->positions.at(body), task.center))++) = body;
    }
    std::copy(scratch.begin() + static_cast<std::ptrdiff_t>(task.begin),
              scratch.begin() + static_cast<std::ptrdiff_t>(task.end),
              order_.begin() + static_cast<std::ptrdiff_t>(task.begin));
    return offsets;
  }

  [[nodiscard]] std::optional<Vec3> contribution(const Node& node, std::size_t particle,
                                                 Vec3 position, const WalkParams& params) const {
    const Vec3 delta = node.center_of_mass - position;
    if (node.coincident) {
      return softened_acceleration(params.gravity * node.mass, delta, params.eps2);
    }

    if (node.leaf) {
      Vec3 sum{};
      for (std::size_t k = node.begin; k < node.end; ++k) {
        const auto body = order_.at(k);
        if (particle != body) {
          sum += softened_acceleration(params.gravity * particles_->masses.at(body),
                                       particles_->positions.at(body) - position, params.eps2);
        }
      }
      return sum;
    }

    const bool contains_body = rank_.at(particle) >= node.begin && rank_.at(particle) < node.end;
    const float width = node.half_width * 2.0F;
    if (!contains_body && node.mass > 0.0F &&
        width * width < params.theta_sq * length_squared(delta)) {
      return softened_acceleration(params.gravity * node.mass, delta, params.eps2);
    }
    return std::nullopt;
  }

  const Particles* particles_;
  std::vector<Node> nodes_;
  std::vector<std::size_t> order_;
  std::vector<std::size_t> rank_;
};

} // namespace

void compute_barnes_hut(Particles& particles, const SimParams& params, float softening_sq) {
  const std::size_t count = count_particles(particles);
  if (count == 0) {
    return;
  }
  const Octree tree(particles);
  const WalkParams walk{
      .gravity = params.gravity,
      .eps2 = softening_sq,
      .theta_sq = params.barnes_hut_theta * params.barnes_hut_theta,
  };
#pragma omp parallel for schedule(static) default(none) shared(particles, count, tree, walk)
  for (std::size_t i = 0; i < count; ++i) {
    particles.accelerations.at(i) = tree.acceleration(i, walk);
  }
}

} // namespace grav
