#pragma once

#include <vector>

namespace grav {

struct Particles;

void merge_collisions(Particles& particles, float radius);

// Each parent is itself or a lower index. Resolve and compact in original order.
void merge_collision_groups(Particles& particles, std::vector<int>& parents);

}
