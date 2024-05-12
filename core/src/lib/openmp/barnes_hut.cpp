#include "lib/openmp/barnes_hut.h"

#include <algorithm>
#include <array>
#include <cmath>
#include <cstddef>
#include <numeric>
#include <vector>

#include "lib/openmp/gravity_force.h"
#include "modules/sim/particles.h"

namespace grav {

namespace {

constexpr std::size_t kLeafCapacity = 8;
constexpr int kMaxDepth = 24;

int octant(Vec3 point, Vec3 center) {
    return (point.x >= center.x ? 1 : 0)
         | (point.y >= center.y ? 2 : 0)
         | (point.z >= center.z ? 4 : 0);
}

struct Node {
    std::size_t begin;
    std::size_t end;
    float half_width;
    std::array<int, 8> children{-1, -1, -1, -1, -1, -1, -1, -1};
    Vec3 center_of_mass{};
    float mass = 0.0F;
    bool leaf = true;
    bool coincident = true;
};

class Octree {
public:
    explicit Octree(const Particles& particles)
        : particles_(particles), order_(particles.count()), rank_(particles.count()) {
        std::iota(order_.begin(), order_.end(), std::size_t{0});
        std::vector<std::size_t> scratch(order_.size());
        Vec3 low = particles.positions.front();
        Vec3 high = low;
        for (const Vec3 p : particles.positions) {
            low = {std::min(low.x, p.x), std::min(low.y, p.y), std::min(low.z, p.z)};
            high = {std::max(high.x, p.x), std::max(high.y, p.y), std::max(high.z, p.z)};
        }
        const Vec3 center = {
            std::midpoint(low.x, high.x),
            std::midpoint(low.y, high.y),
            std::midpoint(low.z, high.z),
        };
        const float half_width = std::max({
            high.x - center.x, high.y - center.y, high.z - center.z,
            center.x - low.x, center.y - low.y, center.z - low.z,
        });
        build(0, order_.size(), center, half_width, 0, scratch);
        for (std::size_t i = 0; i < order_.size(); ++i) {
            rank_[order_[i]] = i;
        }
    }

    Vec3 acceleration(std::size_t i, float gravity, float eps2, float theta_sq) const {
        return walk(0, i, particles_.positions[i], gravity, eps2, theta_sq);
    }

private:
    int build(
        std::size_t begin, std::size_t end, Vec3 center, float half_width, int depth,
        std::vector<std::size_t>& scratch
    ) {
        const int index = static_cast<int>(nodes_.size());
        Node node{begin, end, half_width};
        const Vec3 first = particles_.positions[order_[begin]];
        double total_mass = 0.0;
        std::array<double, 3> weighted{};
        std::array<std::size_t, 8> counts{};
        for (std::size_t k = begin; k < end; ++k) {
            const auto i = order_[k];
            const Vec3 p = particles_.positions[i];
            const double mass = particles_.masses[i];
            total_mass += mass;
            weighted[0] += mass * p.x;
            weighted[1] += mass * p.y;
            weighted[2] += mass * p.z;
            ++counts[octant(p, center)];
            node.coincident &= p.x == first.x && p.y == first.y && p.z == first.z;
        }
        node.mass = static_cast<float>(total_mass);
        node.center_of_mass = total_mass == 0.0 ? first : Vec3{
            static_cast<float>(weighted[0] / total_mass),
            static_cast<float>(weighted[1] / total_mass),
            static_cast<float>(weighted[2] / total_mass),
        };
        if (node.coincident) {
            node.center_of_mass = first;
        }
        nodes_.push_back(node);

        if (end - begin <= kLeafCapacity || node.coincident ||
            depth == kMaxDepth || half_width == 0.0F) {
            return index;
        }

        std::array<std::size_t, 9> offsets{};
        offsets[0] = begin;
        for (int k = 0; k < 8; ++k) {
            offsets[k + 1] = offsets[k] + counts[k];
        }
        auto cursor = offsets;
        for (std::size_t k = begin; k < end; ++k) {
            const auto i = order_[k];
            scratch[cursor[octant(particles_.positions[i], center)]++] = i;
        }
        std::copy(scratch.begin() + begin, scratch.begin() + end, order_.begin() + begin);

        const float child_half = half_width * 0.5F;
        nodes_[index].leaf = false;
        for (int k = 0; k < 8; ++k) {
            if (counts[k] == 0) {
                continue;
            }
            const Vec3 child_center = {
                center.x + ((k & 1) ? child_half : -child_half),
                center.y + ((k & 2) ? child_half : -child_half),
                center.z + ((k & 4) ? child_half : -child_half),
            };
            const int child = build(offsets[k], offsets[k + 1], child_center, child_half,
                                    depth + 1, scratch);
            nodes_[index].children[k] = child;
        }
        return index;
    }

    Vec3 walk(
        int index, std::size_t i, Vec3 position, float gravity, float eps2, float theta_sq
    ) const {
        const auto& node = nodes_[index];
        const Vec3 delta = node.center_of_mass - position;
        if (node.coincident) {
            return softened_acceleration(delta, gravity * node.mass, eps2);
        }

        Vec3 acceleration{};
        if (node.leaf) {
            for (std::size_t k = node.begin; k < node.end; ++k) {
                const auto j = order_[k];
                if (i != j) {
                    acceleration += softened_acceleration(
                        particles_.positions[j] - position, gravity * particles_.masses[j], eps2
                    );
                }
            }
            return acceleration;
        }

        const bool contains_body = rank_[i] >= node.begin && rank_[i] < node.end;
        const float width = node.half_width * 2.0F;
        if (!contains_body && node.mass > 0.0F &&
            width * width < theta_sq * length_squared(delta)) {
            return softened_acceleration(delta, gravity * node.mass, eps2);
        }

        for (const int child : node.children) {
            if (child >= 0) {
                acceleration += walk(child, i, position, gravity, eps2, theta_sq);
            }
        }
        return acceleration;
    }

    const Particles& particles_;
    std::vector<Node> nodes_;
    std::vector<std::size_t> order_;
    std::vector<std::size_t> rank_;
};

}

void compute_barnes_hut(Particles& p, float gravity, float softening_sq, float theta) {
    const auto n = static_cast<std::ptrdiff_t>(p.count());
    if (n == 0) {
        return;
    }
    const Octree tree(p);
    const float theta_sq = theta * theta;
#pragma omp parallel for schedule(static) default(none) shared(p, n, tree, gravity, softening_sq, theta_sq)
    for (std::ptrdiff_t i = 0; i < n; ++i) {
        p.accelerations[i] = tree.acceleration(i, gravity, softening_sq, theta_sq);
    }
}

}
