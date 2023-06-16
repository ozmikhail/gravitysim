#pragma once

namespace grav {
struct Particles;
struct SimParams;
}

namespace grav {

void cpu_step(Particles& particles, const SimParams& params);

}
