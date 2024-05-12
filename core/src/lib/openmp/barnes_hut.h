#pragma once

namespace grav {

struct Particles;

void compute_barnes_hut(Particles& particles, float gravity, float softening_sq, float theta);

}
