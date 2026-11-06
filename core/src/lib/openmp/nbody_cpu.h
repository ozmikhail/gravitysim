#ifndef GRAV_LIB_OPENMP_NBODY_CPU_H
#define GRAV_LIB_OPENMP_NBODY_CPU_H

namespace grav {
struct Particles;
struct SimParams;
} // namespace grav

namespace grav {

void cpu_step(Particles& particles, const SimParams& params);

}

#endif // GRAV_LIB_OPENMP_NBODY_CPU_H
