#include "modules/sim/collisions.h"

#include <algorithm>
#include <cmath>
#include <numeric>

#include "modules/sim/particles.h"

namespace grav {

namespace {

int root_of(std::vector<int>& parents, int index) {
    while (parents[index] != index) {
        parents[index] = parents[parents[index]];
        index = parents[index];
    }
    return index;
}

}

void merge_collision_groups(Particles& p, std::vector<int>& parents) {
    const auto n = p.count();
    if (p.ids.size() != n) {
        p.ids.resize(n);
        std::iota(p.ids.begin(), p.ids.end(), std::size_t{0});
    }

    for (std::size_t i = 0; i < n; ++i) {
        const int root = parents[parents[i]];
        parents[i] = root;
        if (static_cast<std::size_t>(root) == i) {
            continue;
        }

        const float mass = p.masses[root] + p.masses[i];
        if (mass != 0.0F) {
            const float fraction = p.masses[i] / mass;
            p.positions[root] += (p.positions[i] - p.positions[root]) * fraction;
            p.velocities[root] += (p.velocities[i] - p.velocities[root]) * fraction;
        }
        p.masses[root] = mass;
        p.accelerations[root] = {};
    }

    std::size_t out = 0;
    for (std::size_t i = 0; i < n; ++i) {
        if (static_cast<std::size_t>(parents[i]) != i) {
            continue;
        }
        p.positions[out] = p.positions[i];
        p.velocities[out] = p.velocities[i];
        p.accelerations[out] = p.accelerations[i];
        p.masses[out] = p.masses[i];
        p.ids[out] = p.ids[i];
        ++out;
    }
    p.positions.resize(out);
    p.velocities.resize(out);
    p.accelerations.resize(out);
    p.masses.resize(out);
    p.ids.resize(out);
}

void merge_collisions(Particles& p, float radius) {
    if (radius <= 0.0F || p.count() < 2) {
        return;
    }

    std::vector<int> order;
    order.reserve(p.count());
    for (std::size_t i = 0; i < p.count(); ++i) {
        if (std::isfinite(p.positions[i].x)) {
            order.push_back(static_cast<int>(i));
        }
    }
    std::sort(order.begin(), order.end(), [&](int i, int j) {
        return p.positions[i].x < p.positions[j].x;
    });
    std::vector<int> parents(p.count());
    std::iota(parents.begin(), parents.end(), 0);

    const float radius_sq = radius * radius;
    bool merged = false;
    for (std::size_t a = 0; a < order.size(); ++a) {
        const int i = order[a];
        for (std::size_t b = a + 1; b < order.size(); ++b) {
            const int j = order[b];
            const Vec3 delta = p.positions[j] - p.positions[i];
            if (delta.x > radius) {
                break;
            }
            if (length_squared(delta) <= radius_sq) {
                const int first = root_of(parents, i);
                const int second = root_of(parents, j);
                parents[std::max(first, second)] = std::min(first, second);
                merged = true;
            }
        }
    }

    if (merged) {
        merge_collision_groups(p, parents);
    }
}

}
