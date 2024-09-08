#pragma once

namespace grav {

struct Particles;
struct SimParams;

void compute_sph(Particles& particles, const SimParams& params);
void confine_fluid(Particles& particles);

}
